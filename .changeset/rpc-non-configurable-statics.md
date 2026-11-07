---
'mppx': patch
---

Fixed `Store.DurableObjectStore.rpc()` throwing when a subclass shadows a static member or method that an ancestor made non-configurable.
