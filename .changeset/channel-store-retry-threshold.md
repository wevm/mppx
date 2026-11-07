---
'mppx': patch
---

Fixed `ChannelStore` replacing the immediate send that a close request written during a failed queue send scheduled with the 60-second retry, and resending failed settlements forever when `minUnsettledAmount` is `0n` and the deposit is under 10 raw units: the threshold is now at least 1.
