---
'mppx': minor
---

**Breaking:** Removed default `Accept-Payment` headers on every outgoing request for polyfilled fetch in browsers. Now defaults to same-origin requests in browser environments. Non-browser environments are unaffected. Use `acceptPaymentPolicy` to control supported payment origins.
