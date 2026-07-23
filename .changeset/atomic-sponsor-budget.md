---
'mppx': patch
---

Replaced per-sender sponsored charge serialization with atomic aggregate fee-budget reservations so independent expiring-nonce transactions ran concurrently and waited for capacity when the sponsor budget was full.
