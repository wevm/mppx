---
'mppx': patch
---

Added `replayShards` and `replayShardVersion` options to `Store.durableObject`: replay claims spread over a fixed number of SQLite-backed shard objects, each claimed with one SQL statement and cleared by an alarm once expired, instead of one Durable Object per claimed key.
