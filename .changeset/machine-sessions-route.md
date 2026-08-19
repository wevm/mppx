---
'mppx': patch
---

Added implicit machine-token funding to Tempo sessions and moved Tempo charges and sessions to the unified machineUSD deployment. Clients use machineUSD when a verified route and sufficient balance are available and otherwise pay the challenged token. Configured fee-token overrides were bound into session challenges, and concurrent session requests rechecked top-up requirements after serialized opens.
