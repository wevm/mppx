---
'mppx': patch
---

Added `Attestation.Issuer.create`, which signs audience-bound identity attestations of any type with a local or remote Ed25519 key and serves its JSON Web Key Set, and the optional `uid` and `cnf` attestation claims, so one issuer can attest several linked accounts (such as `email`, `github` and `x`) of one user. Added `TempoId.Issuer`, which exchanges a Tempo ID access token for `tempo-id` and `email` attestations, and `TempoId.Client.attestations` and `TempoId.Client.attest`, which obtain them.
