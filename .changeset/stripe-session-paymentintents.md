---
'mppx': patch
---

Added automatic Stripe PaymentIntent recording for Tempo session settlements, using each transaction's newly settled amount rounded down to whole cents. Preserved optional settlement callbacks after recording; applications no longer need to create PaymentIntents in those callbacks.
