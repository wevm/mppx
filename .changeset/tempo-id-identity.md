---
'mppx': patch
---

Added `mppx/extensions/identity/tempo-id`: `TempoId.Server.create` verifies Tempo ID access tokens offline (RS256, audience, client ID and DPoP proofs) as a request-stage verifier, and returns a payment check that requires the Credential's source to be a Tempo Account the token grants to the app. `TempoId.Client.prover` sends the access token, with a DPoP proof per request.
