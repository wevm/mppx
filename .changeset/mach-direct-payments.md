---
'mppx': patch
---

Added direct MACH payments for Tempo charges. With `machineTokenEnabled`, servers now also send `machineTokenDirect: true` and accept MACH transferred 1:1 directly to the recipient alongside the charge currency and legacy swapper payments. Clients pay MACH directly when an offer carries `machineTokenDirect`, and use the swapper only for offers with `machineTokenEnabled` alone.
