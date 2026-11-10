---
'mppx': patch
---

Added a MACH session offer to `tempo({ machineTokenEnabled: true })` and `tempo.session({ machineTokenEnabled: true })`, after the configured currencies. MACH channels work like any other token's; since MACH cannot pay fees, the MACH offer pays them in `feeToken` or the first configured currency.
