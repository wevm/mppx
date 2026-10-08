---
'mppx': patch
---

Fixed `tempo/session` settlement failing after confirmation when a lagging RPC replica served the readback; `settle` read channel state at the receipt's block. Confirmed checkpoint failures were also reported.
