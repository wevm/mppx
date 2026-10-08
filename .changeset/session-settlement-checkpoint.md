---
'mppx': patch
---

Fixed scheduled `tempo/session` settlement marking charges accepted while the settlement transaction was pending as settled. `settle` recorded the spend and units read with the submitted voucher instead.
