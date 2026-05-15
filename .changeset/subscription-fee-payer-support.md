---
"mppx": minor
---

Add fee-payer support to `tempo.subscription`. When a fee payer is configured (via `feePayer: true` or `feePayer: Account`), subscription activation and renewal payments are wrapped in a fee-sponsored transaction so the access key no longer pays its own gas (which previously triggered `SpendingLimitExceeded`). Adds an optional `feePayerPolicy` parameter to override the default fee-payer policy when the access-key + key-authorization tx requires more headroom than the defaults.
