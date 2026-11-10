---
'mppx': patch
---

Added direct MACH payments for Tempo charges and sessions. With `machineTokenEnabled`, servers now also send `machineTokenDirect: true` and accept MACH transferred 1:1 directly to the recipient, alongside the charge currency and, for charges, legacy swapper payments. `machineTokenEnabled` now applies to sessions, whose offers carry only `machineTokenDirect`. Clients pay MACH directly when an offer carries `machineTokenDirect` and fall back to the swapper only for offers with `machineTokenEnabled` alone. Servers reject MACH-enabled challenges whose recipient MACH's transfer policy does not authorize.
