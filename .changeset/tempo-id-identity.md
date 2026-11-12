---
'mppx': patch
---

Added `mppx/extensions/identity/tempo`: `TempoId.Server.create` verifies Tempo ID access tokens offline, with DPoP proofs, and returns a payment check that requires a `tempo` payment from a Tempo Account the token grants to the app. Without `clientId` it accepts any app's token. Its `allow` option decides by the user's ID, app, accounts, compliance states, and the email address of an ID token the client sends. `TempoId.Client.prover` sends the access token, a DPoP proof per request, and the optional ID token.
