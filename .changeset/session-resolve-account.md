---
'mppx': minor
---

Added a `resolveAccount` hook to `tempo.session()` so a wallet can choose which account/access key signs vouchers for a given challenge scope, using the locally cached channel entry or server `recoverContext`. Resume/recover is gated by a payer- and signer-aware check, so a stored channel the resolved account cannot sign for opens fresh instead of producing an invalid voucher. Generalized voucher signing and verification to accept any TIP-1020 primitive signature (secp256k1, p256, webAuthn), rejecting keychain wrappers, multisig, and magic-suffixed encodings.
