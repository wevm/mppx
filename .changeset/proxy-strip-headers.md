---
'mppx': patch
---

Added `headers` to identity verifiers and payment checks, so a proxy strips the headers of the identity protocols its routes use, and `stripHeaders` to `Proxy.create` for extra headers to strip.
