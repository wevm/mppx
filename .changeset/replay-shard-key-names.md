---
'mppx': patch
---

Fixed `Store.durableObject` storing a key named like a replay shard (`mppx:replay:v<version>:<shard>`) in that shard's object, where `DurableObjectStore.isReplayShard()` then reported it as a shard. Such keys, and keys starting with `mppx:key:`, now live in an object named `mppx:key:<key>`, so values stored at them before are no longer found.
