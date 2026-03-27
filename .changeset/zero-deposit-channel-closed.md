---
'mppx': patch
---

Return `410 ChannelClosedError` instead of `402 AmountExceedsDepositError` when a channel's on-chain deposit is zero but the channel still exists (payer is non-zero). This handles a race window during settlement where the escrow contract zeros the deposit before setting the finalized flag.
