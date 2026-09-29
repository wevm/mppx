---
'mppx': patch
---

Added ordered `currencies` configuration to the Tempo and EVM server factories, with OUSD and USDC.e accepted by default on Tempo mainnet. Added chain-aware viem token-set support, deprecated the factories' singular `currency` option, and fixed composition and callback dispatch for multiple offers sharing a payment method.

Preserved proof replay policy when no store was configured, applied session settlement thresholds using each channel's currency, and retained offer selection and error responses through nested composition.

Reduced package size by removing duplicated HTML bundle literals from generated type declarations.

Preserved nested server offer-selection policies when wrapping configured handlers in static composition.

Simplified grouped handler construction and initialized session extensions without mutating previously created methods.
