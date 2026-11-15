---
'mppx': patch
---

Fixed `Poppy.Server.verifier` so a failed key reload keeps the agent's previously loaded keys for up to an hour after they loaded, instead of answering `unavailable` until the next reload. The Poppy prover and verifier now bind any single `Bearer` or `DPoP` token, ignore scheme names inside quoted `Authorization` parameters, and the prover throws instead of signing a Session for an `Authorization` value the verifier would reject.
