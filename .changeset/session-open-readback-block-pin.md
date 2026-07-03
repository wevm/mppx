---
'mppx': patch
---

Fixed a read-after-write race in Tempo session channel open/top-up verification. The on-chain read-back now pins to the block that included the management transaction (instead of reading `latest`) and retries transient failures, so a lagging load-balanced RPC replica can no longer reject a valid open with `on-chain channel state does not match open receipt`.
