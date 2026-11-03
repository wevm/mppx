---
'mppx': patch
---

Applied the `currencies`, `maxAmount`, `maxAtomicAmount` and `expectedRecipients` client options to Tempo session payments. `tempo()` passed them only to its charge method; its session method, and `tempo.session()` given them directly, now skip offers in other currencies, to other recipients or above the cap during selection and reject them before signing or topping up a channel. An explicit close passed to `Mppx.createCredential`, `fetch` or the MCP client stays available for any offer: `canHandleChallenge` now receives the caller's credential context when it is known before selection.
