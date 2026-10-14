---
'mppx': patch
---

Fixed session settlements failing the charged request when a lagging RPC replica reverted the settle while preparing it (such as `ChannelNotFound` right after an open); `settle()` now retries reverted preparations.
