---
'mppx': patch
---

Fixed pre-broadcast simulation in `tempo.charge` and `tempo.session` by stripping `feeToken` and `feePayerSignature` from the simulation request, so the node does not try to recover `feePayerSignature` against a sender signature that viem's `call` action never includes.
