---
'mppx': patch
---

Fixed Tempo subscription `wallet_authorizeAccessKey` RPC payload to send `scopes` (the spec-compliant field) instead of `allowedCalls`, and to hex-encode `limits[].limit` so the parameters match the encoded variant of the `wallet_authorizeAccessKey` schema.
