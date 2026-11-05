---
'mppx': patch
---

Fixed sponsored preflight simulation billing the sender's fee token. Tempo nodes recover the fee payer of an `eth_call` only from `feePayerSignature` and ignore a bare `feePayer` address, so the final simulation charged the sender, and payments failed with "insufficient fee token balance" when the sponsor picked a fee token the sender did not hold. The simulation now carries the sponsor's signature: hosted sponsors return it from `eth_fillTransaction` (`fillHostedFeePayerTransaction` now returns `feePayerSignature`), and local fee-payer accounts sign a simulation-only copy with the new `signFeePayerSimulation`, only after the sender simulation passes. That copy adds `sponsoredSimulationGasBuffer` (10,000) gas, because a sponsored `eth_call` charges more gas than the mined transaction uses.
