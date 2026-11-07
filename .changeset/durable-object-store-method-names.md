---
'mppx': patch
---

Renamed `Store.DurableObjectStore`'s store operations to `storeGet`, `storePut`, `storeDelete`, `storeSwap` and `storeClaim`, so Workers RPC reaches them on Workers whose Durable Object stubs keep the legacy `get`, `put` and `delete` methods, and `fetch` no longer calls a subclass's own methods of those names. `Store.DurableObjectStore.rpc()` now keeps a subclass's static members.

Fixed `DurableObjectStore.isReplayShard()` to match a replay shard's whole object name, so an ordinary key that starts with `mppx:replay:` is not taken for a shard, and the base `alarm()` clears claims only in an object that holds them.
