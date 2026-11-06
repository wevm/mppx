---
'mppx': patch
---

Fixed `tempo.charge` with `waitForConfirmation: false` to throw `Errors.BroadcastOutcomeUnknownError` with the transaction hash after an ambiguous broadcast failure, instead of the raw RPC error. `stripe.recordPayment` now returns the PaymentIntent's Stripe status as `paymentIntentStatus`.
