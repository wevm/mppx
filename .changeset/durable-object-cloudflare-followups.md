---
'mppx': patch
---

Fixed follow-ups in `Store.durableObject` replay shards and `mppx/cloudflare`. Replay shards kept their claims in a table named `mppx_replay_claims`, so the shard alarm no longer clears a subclass's own `replay_claims` table. `ChannelStore` sent a channel to the settlement queue at once on a close request or a threshold's worth of new vouchers, instead of waiting for the watchdog after a failed job. `channels()` no longer let a delayed lookup write for a closed channel replace the entry of a channel the payer can still resume, and its lookup skipped entries whose channel had closed.
