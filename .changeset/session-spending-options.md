---
'mppx': patch
---

Applied the `currencies`, `maxAmount` and `maxAtomicAmount` client options to Tempo session payments. `tempo()` passed them only to its charge method; its session method, and `tempo.session()` given them directly, now skip offers in other currencies or above the cap during selection and reject them before signing or topping up a channel.
