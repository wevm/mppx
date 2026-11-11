---
'mppx': patch
---

Added `mppx/extensions/identity/world`: `World.Server.verifier` requires a human verified with World ID, as an `Identity-Attestation` of type `world-id` from a shared World ID issuer, and `World.Client.prover` runs the issuer's device flow, shows the human World IdP's approval link and sends the attestation.
