---
'mppx': patch
---

Fixed `mppx/cloudflare` settlement and channel lookup: the server's own cooperative-close marker (recorded in the new `pendingCloseAt` channel field) no longer queues an immediate settlement, and `settle()` waits while that close may still land; a new payer close request after an earlier one cleared is sent at once; and each lookup entry keeps up to 8 of the payer's open channels, so closing one leaves the others findable.
