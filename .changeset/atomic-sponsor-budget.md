---
'mppx': patch
---

Replaced per-sender sponsored charge serialization with durable atomic aggregate fee-budget reservations. Independent expiring-nonce transactions ran concurrently, waited for capacity when the sponsor budget was full, and retained pending exposure until receipt reconciliation or transaction expiry.
