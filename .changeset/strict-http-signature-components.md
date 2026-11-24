---
'mppx': patch
---

Rejected HTTP message signatures that cover a component twice or cover `@signature-params`, and Web Bot Auth signatures in algorithms its profile does not support. TAP verification now rejects a nonce already used by any key within the signature lifetime.
