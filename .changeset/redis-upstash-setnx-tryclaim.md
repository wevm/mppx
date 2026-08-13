---
'mppx': patch
---

Added a native `Store.tryClaim` fast path to the `redis` and `upstash` adapters through an optional `setNx` primitive. When provided, a replay claim is a single atomic set-if-absent with an absolute expiry instead of the update-based read-modify-write fallback.
