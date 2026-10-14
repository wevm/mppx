---
'mppx': patch
---

Added a one-time warning when Tempo `charge`, `session`, or `subscription` server methods fall back to an in-memory store, since replay protection backed by it only applies within a single instance.
