---
'mppx': patch
---

Added `DurableObjectStore.isReplayShard()`, so a subclass's `alarm` skips its own work in the replay shards of `Store.durableObject`'s `replayShards`, which are objects of the same class, and documented that values stored at a key don't block its sharded replay claims.
