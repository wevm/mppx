---
'mppx': patch
---

Added `mppx/extensions/identity/world`: `World.Server.verifier` requires a human verified with World ID, as an `Identity-Attestation` of type `world-id` from a World ID issuer, `World.Issuer` runs that issuer as a shared service or inside an app, and `World.Client.prover` runs the issuer's device flow, shows the human World IdP's approval link and sends the attestation.
