---
'mppx': patch
---

Tempo charges and sessions can now be paid in MACH straight to the recipient. List MACH after a stablecoin, such as `currencies: [usdc, mach]`, and older clients keep paying the stablecoin. Clients on this version prefer the MACH offer when the payer holds enough MACH and any access-key limit allows it, paying fees in a stablecoin. MACH can't be the first or only currency, and a MACH charge is never routed through the swapper.
