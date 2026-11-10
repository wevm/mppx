---
'mppx': patch
---

Added direct MACH payments for Tempo sessions. `machineTokenEnabled` now applies to sessions: servers send `machineTokenDirect: true` on session offers when MACH's transfer policy authorizes the recipient, and accept a channel funded in MACH 1:1 alongside the session currency. Clients open the channel in MACH when they hold enough of it.
