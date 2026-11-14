---
'mppx': patch
---

Added `mppx/extensions/identity/poppy`, an identity provider for Poppy (Personal Agent Protocol 1.0) Sessions: `Poppy.Client.prover` signs a fresh `Poppy-Session` JWT for each request, including the paid retry, and `Poppy.Server.verifier` verifies it, with its delegation and the agent's published keys, before any payment Challenge, returning the agent's `client_id`, the pseudonymous User ID, the Session ID and the optional Agent ID.
