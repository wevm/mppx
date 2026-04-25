---
'mppx': patch
---

Bumped `ox` to `0.14.18` so the bundled Tempo payment UI preserves `limits[].period` in the on-chain `KeyAuthorization`. Without this, per-period access keys failed signer recovery and silent signing fell back to the wallet approval dialog.
