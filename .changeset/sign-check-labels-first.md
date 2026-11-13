---
'mppx': patch
---

Fixed HTTP message signing to check a request's existing signature labels before it calls a remote signer, so a request it refuses no longer spends a signing operation.
