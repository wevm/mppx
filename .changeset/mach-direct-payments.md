---
'mppx': patch
---

Added direct MACH payments for Tempo charges and sessions. With `machineTokenEnabled: true`, sessions now accept channels funded in MACH 1:1 with the session currency: sessions have no swapper route, so the payee must be on MACH's merchant list. Charges keep accepting MACH through the swapper, and also accept MACH transferred directly to the recipient when the server adds `machineTokenDirect: true`; leave it off for recipients that can't hold MACH, such as a Stripe deposit address. Challenges that accept MACH directly carry `methodDetails.machineTokenDirect: true`, which older clients ignore, so they keep paying the offer currency or the swapper. Switching `machineTokenDirect` on or off keeps charge challenges already issued valid. Clients pay in MACH when they hold enough of it and the fees are sponsored or a stablecoin they hold can pay them, trying a direct transfer before the swapper, and otherwise pay the offer currency.
