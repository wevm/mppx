---
'mppx': patch
---

Added `onWrite` and `alarm` hooks to `Store.DurableObjectStore`: a subclass sees every applied write with its previous and next values in one storage transaction with the write (so the hook's own writes commit with it, and a hook that throws rolls it back), and can schedule and handle alarms through the protected `storage`, `state` and `env`.
