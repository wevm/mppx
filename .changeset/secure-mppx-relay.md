---
'mppx': patch
---

Stopped reusing cached relay receipts as new payment authorizations. Relay broadcasts now omit idempotency keys so reused credentials are rejected; applications should recover uncertain outcomes separately from executing protected operations.
