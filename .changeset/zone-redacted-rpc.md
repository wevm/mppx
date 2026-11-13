---
'mppx': patch
---

Fixed paying from a Zone whose RPC redacts the outbox's `WithdrawalRequested` event from receipts. The client now derives the sender tag from the outbox's `lastFallbackNonce` and matches the portal's `WithdrawalProcessed` event on Tempo.
