---
'mppx': patch
---

Hardened the Link identity provider: claims challenges also go in `WWW-Authenticate`, issuer outages back off for 30 seconds, `unavailable` reasons are a fixed message, and `tokenVerifier` works with the default `fetch` on Cloudflare Workers.
