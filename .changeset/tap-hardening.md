---
'mppx': patch
---

Added `clockSkew` and per-intent `requiredComponents` to the TAP verifier, a `components` option to the TAP prover, and `Tap.Jwks.resolver` for an agent provider's JSON Web Key Set. HTTP message signatures that cover `content-digest` are now checked against the request body, and TAP verification rejects a request carrying more than one TAP signature.
