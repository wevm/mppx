---
'mppx': patch
---

Fixed `validateStream` to pass its synthesized `Payment: failed` check to `onPaymentResults`, and fixed `validate()` to promise automatic Tempo wallet provisioning only when a payment validator is configured.
