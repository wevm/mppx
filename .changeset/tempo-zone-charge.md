---
'mppx': patch
---

Added Zone payments to the `tempo` charge method. A server lists the Zones it accepts with `zones`, or accepts any Zone with `zones: '*'`, a client pays from a Zone balance with `zone`, and the new `zone` credential is verified from the Zone withdrawal that settles the payment on Tempo, with its challenge-bound memo.

A client waits for the settlement by default and, if the wait fails, throws `Errors.ZoneSettlementPendingError` and resumes the same withdrawal when the challenge is retried. A server rejects a `zone` credential without its settlement hash unless `zoneSettlementTimeoutMs` is set.
