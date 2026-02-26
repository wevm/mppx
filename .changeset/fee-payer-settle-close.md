---
"mppx": patch
---

Added fee payer support to `settleOnChain` and `closeOnChain` for server-originated transactions on chains where the server EOA has no native tokens. Transactions are built using `prepareTransactionRequest` → dual-sign → `sendRawTransactionSync` with an explicitly resolved fee token.
