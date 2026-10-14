---
'mppx': patch
---

Exposed the verified payer as `payer` on payment success contexts and per-method `onPaymentSuccess` hooks. Tempo charge validation now reports the sender address as `payer`.
