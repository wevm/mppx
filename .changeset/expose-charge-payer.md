---
'mppx': patch
---

Exposed the verified payer as `payer` on payment success contexts and per-method `onPaymentSuccess` hooks. Tempo charge and EVM charge validation now report the recovered payer address as `payer`.
