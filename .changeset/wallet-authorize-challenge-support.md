---
'mppx': patch
---

Added `wallet_authorizeChallenge` support. JSON-RPC accounts now delegate Tempo charge and session challenges to wallets that advertise MPP support via `wallet_getCapabilities`, falling back to local signing otherwise.
