---
"mppx": patch
---

Added `waitForConfirmation` option to `session()` and `charge()` payment methods. When `false`, transactions are simulated via `eth_estimateGas` and broadcast without waiting for on-chain confirmation, reducing latency.
