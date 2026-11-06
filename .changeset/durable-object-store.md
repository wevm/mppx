---
'mppx': patch
---

Added `Store.durableObject()` and `Store.DurableObjectStore`, an atomic store backed by Cloudflare Durable Objects with one object per key, for running `tempo.session()` on Cloudflare Workers.
