# Deploy with panda power

```
npm i

gulp deploy --bucketName [BucketName] [optional --cloudflare false (if we don't want to purge cache)]
```
`where BucketName = umar.io`

# Required Env Variable

Just save these variables in a .env file
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
CLOUDFLARE_API_KEY
CLOUDFLARE_EMAIL
```
