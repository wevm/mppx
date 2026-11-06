---
'mppx': patch
---

Added `Errors.BroadcastOutcomeUnknownError`, which `tempo.charge` now throws with the transaction hash and `validBefore` when an ambiguous broadcast leaves no receipt, instead of rethrowing the RPC error (still its `cause`). Added `stripe.recordPayment` to record a settled payment as a Stripe PaymentIntent, idempotent per transaction hash.
