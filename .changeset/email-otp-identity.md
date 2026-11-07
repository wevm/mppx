---
'mppx': patch
---

Added `mppx/extensions/identity/email-otp`: `EmailOtp.Server.verifier` requires a verified email address, sent as an issuer-signed attestation in `Identity-Attestation` and bound to the server's origin, and `EmailOtp.Client.prover` obtains one with a one-time code when a server answers 401 with `Identity-Attestation-Required`. Added `Identity.from` and `Identity.Rejection` to `mppx/identity`, which turn a function, such as a lookup in your own database, into a route identity verifier.
