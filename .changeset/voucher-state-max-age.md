---
'mppx': patch
---

Added `voucherStateMaxAge` to `tempo.session()`. Vouchers within the deposit of on-chain state verified that recently are accepted without waiting for a fresh on-chain read, which finishes in the background and records a pending close for later vouchers. The verification time is persisted on the stored channel so every server instance can use it. The default `0` keeps reading on-chain state before every acceptance.
