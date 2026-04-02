---
'mppx': patch
---

Fixed CLI defaulting to testnet when `--rpc-url` is omitted. The CLI now defaults to Tempo mainnet. Also added `resolveRpcUrl` helper so `MPPX_RPC_URL` and `RPC_URL` env vars are respected consistently across all commands.
