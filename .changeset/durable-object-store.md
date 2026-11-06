---
'mppx': patch
---

Added `Store.durableObject()` and `Store.DurableObjectStore`, an atomic store backed by Cloudflare Durable Objects (one object per key, compare-and-swap with jittered retries), for running `tempo.session()` and replay protection on Cloudflare Workers.
