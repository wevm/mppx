---
'mppx': patch
---

Added the `Currency` module and accepted `viem/tokens` tokens, chain-indexed (`ousd`) or resolved to one chain (`ousd(4217)`), everywhere a currency is configured: Tempo charge and session client `currencies`, `autoSwap.tokenIn`, Tempo server `currencies`, and EVM and x402 `currencies`, with token decimals used for `maxAmount`, `maxDeposit` and `topUpAmount`.
