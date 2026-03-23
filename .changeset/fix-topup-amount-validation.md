---
'mppx': patch
---

Skipped route amount/currency/recipient validation for topUp and voucher credentials. These `POST`s carry no application body so the route's request hook may produce a different amount than the challenge echoed from the original request. The on-chain voucher signature is the real validation.
