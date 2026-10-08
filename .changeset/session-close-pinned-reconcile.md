---
'mppx': patch
---

Fixed `tempo/session` reopening an expired pending close from a lagging RPC. Reconciliation read channel state at a block whose timestamp passed the close's validity window.
