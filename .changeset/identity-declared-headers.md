---
'mppx': patch
---

Moved identity protocol headers out of `Identity.Headers`: each identity extension now declares its own headers on its verifier, payment check and prover, so the proxy and the client's redirect stripping read them from the extensions a route or client uses.
