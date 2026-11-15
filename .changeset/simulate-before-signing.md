---
'mppx': patch
---

Added `Errors.SpendingLimitExceededError`. The Tempo charge client and session open and top-up now throw it, or `Errors.InsufficientBalanceError`, when the pre-signing gas estimate reverts with the access key's `SpendingLimitExceeded` or the token's `InsufficientBalance`, instead of signing a transaction that would revert on chain at the fee payer's cost.
