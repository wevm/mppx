---
'mppx': patch
---

Fixed Tempo session voucher, close authorization and subscription key authorization verification to reject secp256k1 signatures with a high `s` value, which Tempo does not accept onchain.
