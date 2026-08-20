---
'mppx': patch
---

Hardened machine-token session flows after #800: kept stored machine channels instead of evicting them on failed retries, advertised close snapshots for signature-verified close credentials, accepted sponsored fees in the payment currency alongside a configured `feeToken`, and restored balance-aware fee-token selection for direct-channel settlement.
