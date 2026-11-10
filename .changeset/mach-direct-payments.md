---
'mppx': patch
---

Added direct MACH payments for Tempo charges and sessions. With `machineTokenEnabled`, servers now also send `machineTokenDirect: true` and accept MACH 1:1 alongside the offer currency: charges accept MACH transferred directly to the recipient as well as legacy swapper payments, and sessions accept a channel funded in MACH. Clients pay in MACH when they hold enough of it and the fees are sponsored or a stablecoin they hold can pay them, and otherwise pay the offer currency. Charge offers with `machineTokenEnabled` alone still use the swapper.
