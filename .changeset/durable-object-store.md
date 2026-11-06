---
'mppx': patch
---

Added `Store.durableObject()` and `Store.DurableObjectStore`, an atomic store backed by Cloudflare Durable Objects (one object per key, compare-and-swap with jittered retries), and moved the examples to run as Cloudflare Workers locally in workerd.
