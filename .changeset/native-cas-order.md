---
'mppx': patch
---

Fixed `Store.durableObject` native compare-and-swap to compare object keys, map entries and set members in order, compare sparse arrays by their own elements instead of scanning to their length, and tell resizable `ArrayBuffer`s apart.
