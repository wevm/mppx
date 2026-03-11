---
"mppx": patch
---

Set `feeToken` during server co-sign and simulation for fee-payer transactions.

When the client sends a fee-payer (0x78) envelope, `feeToken` is intentionally omitted. The server must set it at co-sign time, but previously never did — causing "Fee token spending limit exceeded" errors. Now resolves `feeToken` from the deserialized transaction or falls back to the chain's default currency.
