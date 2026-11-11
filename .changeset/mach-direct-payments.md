---
'mppx': patch
---

Added direct MACH payments for Tempo charges and sessions. Servers opt in with `machineTokenDirect: true` alongside `machineTokenEnabled: true`; their challenges then carry `machineTokenDirect: true` and accept MACH 1:1 in place of the offer currency: charges accept MACH transferred directly to the recipient as well as swapper payments, and sessions accept a channel funded in MACH. `machineTokenEnabled` alone keeps today's swapper-only behavior, for recipients that can't hold MACH such as a Stripe deposit address. Clients pay in MACH when they hold enough of it and the fees are sponsored or a stablecoin they hold can pay them, and otherwise pay the offer currency.
