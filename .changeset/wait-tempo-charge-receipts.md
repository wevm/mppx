---
'mppx': patch
---

Waited for Tempo charge receipts until a configurable `confirmationTimeoutMs` deadline (default 30 seconds) when a synchronous broadcast failed with an unknown outcome, such as an RPC timeout or an "already known" response, instead of failing while the transaction was still pending.
