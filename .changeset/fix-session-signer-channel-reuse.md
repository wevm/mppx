---
'mppx': patch
---

Fixed legacy session auto-management reusing a cached channel after the account's `authorizedSigner` changed. The client now opens a new channel instead of emitting a voucher the escrow would reject.
