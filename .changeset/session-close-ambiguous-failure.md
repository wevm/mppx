---
'mppx': patch
---

Fixed `tempo/session` reopening a channel when a broadcast close failed while waiting for its receipt. The pending-close marker is now cleared only when no transaction hash was returned or the close reverted.
