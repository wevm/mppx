---
'mppx': patch
---

Added `headers` declarations to every identity extension's verifier, payment check and prover, so a proxy and the client's redirect stripping find each protocol's headers from the extension itself.
