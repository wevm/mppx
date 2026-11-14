---
'mppx': patch
---

Aligned with the MPP core and Tempo charge specs: replayed credentials now get 402 with a fresh Challenge (`invalid-challenge`), Challenges carry an `_mpp_nonce` (`challengeNonce: false` turns it off), the Tempo attribution memo is optional on the server for pull (`transaction`) credentials, method identifiers are a-z only, requests with more than one Payment credential get 400, body digest mismatches get `invalid-challenge`, and `onChallenge` can return `false` to decline payment.
