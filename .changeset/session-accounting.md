---
'mppx': minor
---

Added session accounting primitives to the Tempo session server, so payment servers no longer edit channel records themselves.

- `Session.Server.charge()` (also `tempo.session.charge()`) accepted an `idempotencyKey`: a retry with the same key and amount returned the recorded charge without charging again, and the same key with another amount threw `IdempotencyKeyConflictError`. It also accepted a `Store` as well as a channel store.
- Added `Session.Server.credit()` (also `tempo.session.credit()`), which returned an amount to a channel's `spent` at most once per key. Its first outcome was final: `credited`, `declined` when the channel was closing or finalized or the credit would take `spent` below zero or below what settled or may still settle on-chain, or `unknown` when the store write failed and may have committed.
- Keyed charge and credit outcomes were recorded on the channel record for `retention` (24 hours by default) and removed by the channel's next keyed charge or credit, so they worked with every channel store.
- `settle()` and the settlement schedule settled the largest accepted voucher at or below `spent` (`Session.Server.resolveSettleableVoucher()`) instead of the highest voucher, which a credit can leave above `spent`; channels kept up to 16 earlier vouchers for this. A settlement held a credit floor at its amount until its transaction could no longer land. **Breaking:** `settle()` no longer captured a voucher above `spent`, and threw "nothing to settle" when no accepted voucher was within `spent`.
- Added `tempo.superviseCloses()` (also `Session.Server.superviseCloses()`) for a scheduled job: it read the escrow state of the given channels at one pinned block, answered payer close requests with a payee close capturing `max(spent, settled)` with configurable fee payment, finalized channels whose deposit left the escrow from their `ChannelClosed` event, and reopened channels whose close request was cancelled.
- Added `sponsorshipLimit` to `tempo.session()`, which limited fee-payer-sponsored opens, and separately top-ups, to five per verified transaction signer per UTC day, counted in a `Store.AtomicStore`.
- `Chain.getChannelStatesBatch()` accepted a block number.
