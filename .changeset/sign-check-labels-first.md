---
'mppx': patch
---

Fixed HTTP message signing to check a request's signature labels, the new label and a consumed body before it calls a remote signer, so a request it refuses no longer spends a signing operation.
