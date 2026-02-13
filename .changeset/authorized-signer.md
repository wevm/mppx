---
"mpay": patch
---

Added `authorizedSigner` parameter to `session()` and `sessionManager()`. This allows a separate address (e.g. a secp256k1 access key) to sign vouchers while the root account funds the escrow channel. When `authorizedSigner` is set, keychain envelope signatures are automatically unwrapped to raw ECDSA for on-chain verification. This is a workaround until TIP-1020 enshrinement.
