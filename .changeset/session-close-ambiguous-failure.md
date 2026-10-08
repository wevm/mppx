---
'mppx': patch
---

Fixed `tempo/session` reopening a channel when a broadcast close failed ambiguously. The pending-close marker now stays until the close transaction expires, and a later voucher or close clears it once the chain shows the channel still open.
