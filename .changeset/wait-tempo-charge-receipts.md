---
'mppx': patch
---

Bounded synchronous Tempo charge broadcasts by a configurable `confirmationTimeoutMs` deadline (default 30 seconds). When the broadcast outcome is unknown, such as a timeout, a lost connection, or an "already known" response, the receipt is now polled until the deadline instead of failing while the transaction is still pending. Definitive RPC rejections still fail immediately.
