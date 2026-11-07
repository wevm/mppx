---
'mppx': patch
---

Fixed `mppx/cloudflare` so `channels()` skips a channel opened with another operator than the challenge's, `settle()` renews its settlement lease while a settlement runs, and `ChannelStore` resends a closing channel within 2 minutes so every attempt fits in the escrow's close grace period.
