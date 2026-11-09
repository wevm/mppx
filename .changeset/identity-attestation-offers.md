---
'mppx': patch
---

Added identity offers on a 402. Attestation verifiers expose an `offer` header (`Identity-Attestation-Offered`) that a route sets on a 402 it would price lower with that attestation. Provers gained an optional `offer` hook, which the attestation prover uses to acquire the offered attestation and resend the unpaid request once.
