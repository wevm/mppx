---
'mppx': patch
---

Added identity attestations: `mppx/extensions/identity/attestation` verifies issuer-signed Ed25519 attestations sent in the `Identity-Attestation` header and bound to the server's origin, and obtains them when a server answers 401 with `Identity-Attestation-Required`. Added `mppx/extensions/identity/email-otp`, the first attestation type: a server requires a verified email address with `EmailOtp.Server.verifier`, and `EmailOtp.Client.prover` gets one with a one-time code sent by the issuer. Added `Attestation.Server.callback`, which plugs a server's own identity system (API keys, sessions, KYC) into the same 401 flow, so a route can accept it or a verified email with `Identity.anyOf`.
