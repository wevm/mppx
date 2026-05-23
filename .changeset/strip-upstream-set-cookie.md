---
'mppx': patch
---

Stripped `Set-Cookie` from upstream responses in `Proxy.scrubResponse` so an upstream service cannot set cookies under the proxy's origin.
