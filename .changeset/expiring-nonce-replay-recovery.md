---
'mppx': patch
---

Fixed Tempo charge settlement returning a fresh 402 after a paid transaction was mined: a broadcast rejected with `ExpiringNonceReplay` (for example, a retried send) now recovers the transaction's receipt instead of failing.
