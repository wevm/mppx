---
'mppx': patch
---

Added `autoSwap.fallback` to Tempo charges. Setting `fallback: false` swaps only from `tokenIn`, as an allowlist, instead of also trying pathUSD and USDC afterwards.
