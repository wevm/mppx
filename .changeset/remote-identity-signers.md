---
'mppx': minor
---

Added remote signers (a cloud KMS, an HSM or Turnkey) to the Web Bot Auth and TAP client provers, `Attestation.sign` and the World ID issuer, through one `SigningKey` type: a `CryptoKeyPair` or a `Signer` (`{ publicKey, sign({ payload }) }`). mppx checks each remote signature against `publicKey` before it uses it.

Breaking: these take a key pair instead of a private key alone. `WebBotAuth.Client.prover` no longer takes `keyId`: it derives the keyid from the public key. `Attestation.sign`'s `keyId` is optional and defaults to the public key's RFC 7638 thumbprint.

```diff
- WebBotAuth.Client.prover({ key: keys.privateKey, keyId, scope, signatureAgent })
+ WebBotAuth.Client.prover({ key: keys, scope, signatureAgent })
- Tap.Client.prover({ key: keys.privateKey, keyId, intent, scope })
+ Tap.Client.prover({ key: keys, keyId, intent, scope })
- Attestation.sign(claims, { key: keys.privateKey, keyId })
+ Attestation.sign(claims, { key: keys })
```
