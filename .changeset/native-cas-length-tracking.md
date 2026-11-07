---
'mppx': patch
---

Fixed `Store.DurableObjectStore`'s native compare-and-swap treating a length-tracking view of a resizable `ArrayBuffer` as equal to a fixed-length one.
