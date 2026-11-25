---
'mppx': patch
---

Added `stripHeaders` to `Proxy.create`: extra request headers the proxy never forwards upstream and extra response headers it never returns to the client, beyond the built-in payment and identity headers.
