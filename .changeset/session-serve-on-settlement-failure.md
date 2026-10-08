---
'mppx': minor
---

Changed failed scheduled `tempo/session` settlements to serve the charged request instead of failing it. The charge stays on the channel for the next settlement, and the failure is reported to `onSessionSettlementFailure`.
