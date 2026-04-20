---
'mppx': minor
---

**Breaking:** Removed default `Accept-Payment` headers on every outgoing request for polyfilled fetch. Now defaults to same-origin requests. Use `acceptPaymentPolicy.origins` to control supported payment origins.
