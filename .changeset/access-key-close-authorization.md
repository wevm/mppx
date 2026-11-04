---
'mppx': patch
---

Fixed closing a Tempo session paid with a Viem Tempo access key account. `signCloseAuthorization` now signs the close authorization hash raw with the access key, as vouchers already do, instead of returning a keychain signature that TIP-1034 rejects.
