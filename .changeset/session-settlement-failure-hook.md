---
'mppx': patch
---

Added `onSessionSettlementFailure` to `tempo.session()`, called with the chain, channel, error and trigger (`scheduled` or `close`) when a scheduled settlement or close transaction fails.
