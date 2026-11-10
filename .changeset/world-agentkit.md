---
'mppx': patch
---

Added `mppx/extensions/identity/world`: `World.Server.verifier` requires a request signed by an agent wallet that a World ID-verified human registered in World's AgentBook, and `World.Client.prover` signs requests with that wallet. Both use the AgentKit header and message format from x402.
