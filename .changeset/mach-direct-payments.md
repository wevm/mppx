---
'mppx': patch
---

Added direct MACH payments for Tempo charges and sessions with a new `machineTokenAccepted: true` server option, independent of `machineTokenEnabled`. With it, charges accept MACH transferred directly to the recipient and sessions accept channels funded in MACH, both 1:1 with the offer currency; the recipient must be on MACH's merchant list. `machineTokenEnabled` keeps meaning MACH through the swapper, for charges only. Challenges that accept MACH directly carry `methodDetails.machineTokenAccepted: true`, which older clients ignore, so they keep paying the offer currency or using the swapper. Switching `machineTokenAccepted` on or off keeps charge challenges already issued valid. Clients pay in MACH when they hold enough of it and the fees are sponsored or a stablecoin they hold can pay them, trying a direct transfer before the swapper, and otherwise pay the offer currency.
