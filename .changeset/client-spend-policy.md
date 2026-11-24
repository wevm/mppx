---
'mppx': patch
---

Added `maxPayment`, `authorize` (with `Budget.create`), `funders` and `tokens` options to the client, checked before any credential is created. A credential an event handler or `onChallenge` returns is checked against the offered challenge it pays. Added the decoded receipt, amount and normalized requirement to `payment.response` events.
