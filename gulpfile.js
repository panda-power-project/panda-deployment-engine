const gulp = require('gulp')
const path = require('path')
const Console = console

// Build production files and deploy to s3
gulp.task('deploy', cb => {
  require('dotenv').config()
  const fs = require('fs')
  const args = require('yargs').argv
  const readdirp = require('readdirp')
  const AWS = require('aws-sdk')
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  })
  // gulp deploy --bucketName umar.io
  const Bucket = args.bucketName
  const cloudflare = args.cloudflare || true
  const dir = `dist`
  // const dir = `${args.dir}/${Bucket}/dist`;
  if (!Bucket || !dir) {
    return cb(new Error('Missing bucketName or dir'))
  }
  const wwwBucket = `www.${Bucket}`
  const ACL = 'public-read'
  const WebsiteConfiguration = {
    ErrorDocument: {
      Key: 'index.html',
    },
    IndexDocument: {
      Suffix: 'index.html',
    },
  }
  const wwwWebsiteConfiguration = {
    RedirectAllRequestsTo: {
      HostName: Bucket,
      Protocol: 'https',
    },
  }
  const createBucket = new Promise((resolve, reject) => {
    s3.createBucket({Bucket, ACL}, (err, data) => {
      if (err && err.code !== 'BucketAlreadyOwnedByYou') {
        return reject(new Error(err))
      }
      return resolve(data)
    })
  })
  const createWWWBucket = new Promise((resolve, reject) => {
    s3.createBucket({Bucket: wwwBucket, ACL}, (err, data) => {
      if (err && err.code !== 'BucketAlreadyOwnedByYou') {
        return reject(new Error(err))
      }
      return resolve(data)
    })
  })
  const fileUploadPromises = []
  // Creates the buckets
  Promise.all([createBucket, createWWWBucket])
    .then(data => {
      Console.log('Create Bucket', data)
      const stream = readdirp({root: path.join(__dirname, dir)})
      stream
        .on('warn', err => {
          Console.error('non-fatal error', err)
          // optionally call stream.destroy() here in order to abort and cause 'close' to be emitted
        })
        .on('error', err => {
          Console.error('fatal error', err)
          stream.destroy()
          return cb(new Error(err))
        })
        .on('data', entry => {
          // upload all the files
          fileUploadPromises.push(new Promise((resolve, reject) => {
            s3.upload({
              Bucket,
              ACL,
              Key: entry.path,
              Body: fs.readFileSync(entry.fullPath),
              ContentType: getContentTypeByFile(entry.name),
            }, (err, data) => {
              if (err) {
                Console.log('s3.upload err', err)
                return reject(new Error(err))
              }
              return resolve(data)
            })
          }))
        })
        .on('end', () => {
          Promise.all(fileUploadPromises)
            .then(data => {
              Console.log('fileUpload', data)
              // make the bucket static hosting
              const configureBucketForHosting = new Promise((resolve, reject) => {
                s3.putBucketWebsite({Bucket, WebsiteConfiguration}, (err, data) => {
                  if (err) {
                    return reject(new Error(err))
                  }
                  return resolve(data)
                })
              })
              const configureWWWBucketForHosting = new Promise((resolve, reject) => {
                s3.putBucketWebsite({
                  Bucket: wwwBucket,
                  WebsiteConfiguration: wwwWebsiteConfiguration,
                }, (err, data) => {
                  if (err) {
                    return reject(new Error(err))
                  }
                  return resolve(data)
                })
              })
              Promise.all([configureBucketForHosting, configureWWWBucketForHosting])
                .then(data => {
                  Console.log('Configuring static hosting', data)
                  if (cloudflare) {
                    purgeCloudflareCache(Bucket)
                      .then(data => {
                        Console.log('CloudFlare Cache Purged', data)
                        return cb()
                      })
                      .catch(err => {
                        Console.log('Purge Failed', err)
                        return cb()
                      })
                  } else {
                    return cb()
                  }
                })
                .catch(err => {
                  Console.log('Configuring static hosting err', err)
                  return cb(new Error(err))
                })
            })
            .catch(err => {
              return cb(new Error(err))
            })
        })
    })
    .catch(err => {
      Console.log('Create Bucket Err', err)
      return cb(new Error(err))
    })
})

/**
 * Generate the appropriate ContentType by extensions
 * @param  {String} fileName name of the file with extension
 * @return {String}          ContentType
 */
function getContentTypeByFile (fileName) {
  var rc = 'application/octet-stream'
  var fn = fileName.toLowerCase()

  if (fn.indexOf('.html') >= 0) {
    rc = 'text/html'
  } else if (fn.indexOf('.css') >= 0) {
    rc = 'text/css'
  } else if (fn.indexOf('.json') >= 0) {
    rc = 'application/json'
  } else if (fn.indexOf('.js') >= 0) {
    rc = 'application/x-javascript'
  } else if (fn.indexOf('.png') >= 0) {
    rc = 'image/png'
  } else if (fn.indexOf('.jpg') >= 0) {
    rc = 'image/jpg'
  }

  return rc
}

/**
 * Purge all cloudflare cache for a zone
 * @param  {String} Bucket eg umar.io
 * @return {Object}        Response
 */
function purgeCloudflareCache (Bucket) {
  const request = require('unirest')
  const CLOUDFLARE_URL = 'https://api.cloudflare.com/client/v4'
  const CLOUDFLARE_HEADERS = {
    'X-AUTH-KEY': process.env.CLOUDFLARE_API_KEY,
    'X-AUTH-EMAIL': process.env.CLOUDFLARE_EMAIL,
  }
  return new Promise((resolve, reject) => {
    request.get(`${CLOUDFLARE_URL}/zones`)
      .headers(CLOUDFLARE_HEADERS)
      .query({
        status: 'active',
        per_page: 50
      })
      .end(zonesRes => {
        if (zonesRes.error) {
          Console.log('get zones ERR', zonesRes.error)
        }
        const zones = zonesRes.body.result
        const identifier = zones.find(z => z.name === Bucket).id
        if (identifier) {
          request.delete(`${CLOUDFLARE_URL}/zones/${identifier}/purge_cache`)
            .headers(Object.assign({
              'Content-Type': 'application/json',
            }, CLOUDFLARE_HEADERS))
            .send({
              purge_everything: true // eslint-disable-line
            })
            .end(purgeRes => {
              if (purgeRes.error) {
                return reject(new Error(purgeRes.error))
              }
              return resolve(purgeRes.body)
            })
        } else {
          return resolve('Not found')
        }
      })
  })
}
