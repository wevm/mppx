---
'mppx': patch
---

Fixed `tempo/session` `onSessionSettlement` double-counting a retried settlement after a failed checkpoint; `delta` now comes from the receipt's `deltaPaid`. Exported `SettlementCheckpointError` as `tempo.SettlementCheckpointError` from `mppx/server`.
