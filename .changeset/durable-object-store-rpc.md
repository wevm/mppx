---
'mppx': patch
---

Added `transport: 'rpc'` and `encoding: 'native'` options to `Store.durableObject`: the store calls the object's methods over Workers RPC (with a class from `Store.DurableObjectStore.rpc(DurableObject)`), and native encoding stores structured-clone values, so bigints stay intact and values a Durable Object wrote with `storage.put` read back.
