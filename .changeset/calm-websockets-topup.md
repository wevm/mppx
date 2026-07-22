---
'mppx': patch
---

Top up a full reusable session channel before signing its WebSocket opening
credential. Reuse the server's suggested deposit as refill headroom for
automatic top-ups, bounded by the client's `maxDeposit` policy.

Do not advertise bootstrap snapshots for channels already marked as closing.
