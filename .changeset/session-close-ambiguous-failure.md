---
'mppx': patch
---

Fixed `tempo/session` reopening a channel when a broadcast close failed ambiguously. The pending-close marker stayed until the close transaction expired, and a later voucher or close cleared it once the chain showed the channel still open.
