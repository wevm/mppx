---
'mppx': patch
---

Fixed the client throwing `No Payment schemes found.` on a `402` whose `WWW-Authenticate` has no Payment challenge, so other protocols such as x402 now handle it.
