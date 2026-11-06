---
'mppx': patch
---

Added `Errors.PaymentSimulationError`, which wraps a failed fee-sponsored preflight simulation with its `phase` (`sender` or `sponsored`), `sender`, `feePayer` and `paymentToken`, so callers can tell a payer's insufficient balance from a sponsor's. Fixed the sponsored simulation dropping a zero `maxPriorityFeePerGas`, which broke a hosted fee payer's signature.
