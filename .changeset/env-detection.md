---
"mppx": patch
---

Added auto-detection of `realm` and `secretKey` from environment variables in `Mppx.create()`.

- **Realm**: checks `MPP_REALM`, `FLY_APP_NAME`, `HEROKU_APP_NAME`, `HOST`, `HOSTNAME`, `RAILWAY_PUBLIC_DOMAIN`, `RENDER_EXTERNAL_HOSTNAME`, `VERCEL_URL`, `WEBSITE_HOSTNAME`
- **Secret key**: checks `MPP_SECRET_KEY`
