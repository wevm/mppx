---
'mppx': minor
---

Added a `proof` credential type for zero-amount Tempo charge requests. Clients now sign an EIP-712 proof over the challenge ID instead of creating a broadcastable transaction, and servers verify the proof against the credential source DID before accepting the request. This prevents zero-dollar auth flows from burning gas when the payer would otherwise have been the fee payer.
