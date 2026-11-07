---
'mppx': patch
---

Changed `Store.DurableObjectStore`'s native encoding to reject views of resizable `ArrayBuffer`s, as it rejects other values it cannot compare, instead of probing their length tracking with a copy of the whole buffer resized to its maximum on every compare-and-swap.
