---
'mppx': patch
---

Added direct MACH payments for Tempo sessions. `machineTokenEnabled` now applies to sessions: session offers carry `machineTokenDirect: true`, and servers accept a channel funded in MACH 1:1 alongside the session currency. Clients open the channel in MACH when they hold enough of it and fall back to the session currency otherwise.
