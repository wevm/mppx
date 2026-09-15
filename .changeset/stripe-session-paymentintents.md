---
'mppx': patch
---

Added automatic Stripe PaymentIntent recording for Tempo session settlements, using each transaction's newly settled amount rounded down to whole cents and recording the session intent in analytics metadata. Preserved optional settlement callbacks after recording; applications no longer need to create PaymentIntents in those callbacks.
