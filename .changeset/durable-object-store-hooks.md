---
'mppx': patch
---

Added `onWrite` and `alarm` hooks to `Store.DurableObjectStore`: a subclass sees every applied write with its previous and next values, atomically with the write, and can schedule and handle alarms through the protected `storage`, `state` and `env`.
