---
'mppx': patch
---

Added storeless charge replay protection via challenge-ID memo binding. When no `store` is provided, the challenge ID is used as the TIP-20 `transferWithMemo` memo, eliminating the need for a KV/Redis store.
