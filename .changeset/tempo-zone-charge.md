---
'mppx': patch
---

Added Zone payments to the `tempo` charge method. A server lists the Zones it accepts with `zones: [3, 7]`, or accepts any Zone with `zones: true`. A client pays from a Zone balance with `zone`: it withdraws to the recipient with a challenge-bound memo, waits for the withdrawal to settle on Tempo, and sends a `zone` credential with the settlement transaction hash, which the server verifies.

If the wait fails, the client throws `Errors.ZoneSettlementPendingError` and resumes the same withdrawal when the challenge is retried.
