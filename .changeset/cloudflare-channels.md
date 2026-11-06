---
'mppx': patch
---

Added `mppx/cloudflare`: a `ChannelStore` Durable Object that stores Tempo session channels and sends them to a settlement queue by amount or staleness, with a watchdog; `channels()`, the store and reusable-channel lookup for `tempo.session()`; and `settle()`, the queue consumer that settles them on-chain.
