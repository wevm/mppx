---
'mppx': patch
---

Added `acceptMachineToken` to the Tempo server. It adds MACH, paid straight to the recipient, as the last offer of every Tempo charge and session; older clients keep paying the currencies listed before it. Clients on this version prefer the MACH offer when the payer holds enough MACH and can pay its gas in a stablecoin, or the server sponsors gas. MACH can no longer be listed as a currency directly, including on a route, and the MACH offer is never routed through the swapper.
