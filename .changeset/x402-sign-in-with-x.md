---
'mppx': patch
---

Added x402 `sign-in-with-x` support: `evm.charge({ x402: { siwx } })` lets a wallet that signs the 402's challenge get the resource without paying when `grant` approves it, and `Siwx.wrapFetch` answers that challenge on the client before mppx pays.
