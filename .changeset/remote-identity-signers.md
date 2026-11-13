---
'mppx': patch
---

Added `Signer` and `SigningKey` types so the Web Bot Auth and TAP client provers and `Attestation.sign` accept a remote signer (a cloud KMS, an HSM or Turnkey) in place of a `CryptoKey`.
