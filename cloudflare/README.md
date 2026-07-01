# R2 direct uploads and CDN worker

This folder contains the Cloudflare Worker used by Mattermost direct file delivery.

## Mattermost config

Use the existing S3-compatible file store settings for R2, then enable the new direct upload/CDN settings:

```json
{
  "FileSettings": {
    "DriverName": "amazons3",
    "AmazonS3Bucket": "mattermost-files",
    "AmazonS3Endpoint": "<account_id>.r2.cloudflarestorage.com",
    "AmazonS3Region": "auto",
    "AmazonS3SSL": true,
    "EnableDirectFileUploads": true,
    "DirectFileUploadExpiresSeconds": 900,
    "FileCDNURL": "https://files.example.com/object",
    "FileCDNSigningSecret": "<same-secret-as-worker>",
    "FileCDNURLExpiresSeconds": 300
  }
}
```

Keep `FileCDNSigningSecret` identical to the Worker secret `FILE_CDN_SIGNING_SECRET`.

## R2 CORS

Allow browser uploads from the Mattermost origin:

```json
[
  {
    "AllowedOrigins": ["https://chat.example.com"],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## Worker bindings

`r2-file-worker.js` expects:

- `FILES_BUCKET`: R2 bucket binding for stored files.
- `IMAGES`: Cloudflare Images binding for thumbnail/preview transforms.
- `FILE_CDN_SIGNING_SECRET`: Worker secret matching Mattermost config.
- `CORS_ALLOWED_ORIGINS`: comma-separated Mattermost origins that may fetch CDN redirects, for example `http://localhost:8065,https://chat.example.com`.

Full file delivery works with only the R2 binding. Thumbnail/preview transforms return `501` until the Images binding is configured.

The Worker stores generated image derivatives back into R2 under `_mattermost_derivatives/`.
This avoids repeating expensive thumbnail/preview transforms for heavy images and lets prewarm
requests make subsequent chat rendering fast.
