---
'mppx': patch
---

Fixed Tempo charge so a retry that overlaps an unknown broadcast outcome recovers the server's own transaction: the broadcast record is written before the replay claims are released, and ownership is checked again once the receipt arrives.
