---
'mppx': patch
---

Fixed `tempo/session` failing a charged request when its settlement confirmed but the channel store could not record it. `settle` raised `SettlementCheckpointError` with the transaction hash instead.
