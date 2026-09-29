---
'mppx': minor
---

Added ordered `currencies` configuration to the Tempo and EVM server factories, with OUSD followed by USDC.e on Tempo mainnet and OUSD followed by pathUSD on Moderato. Added chain-aware viem token-set support and deprecated the factories' singular `currency` option. Explicit currency configuration continued to restrict acceptance to that currency.

Changed `tempo.charge()`, `tempo.session()`, and `tempo.subscription()` to return ordered method groups. Existing `methods: [tempo.charge(options)]` configuration remained supported. Code inspecting a single method directly must now destructure the returned group; explicit composition should use configured handlers such as `mppx.tempo.charge`. Wire Challenges and per-handler currency overrides remained singular.

Preserved offer selection, callbacks, and error responses through nested composition. Preserved proof replay policy without a configured store and honored explicit charge chain IDs. Shared session storage and settlement dispatch across accepted currencies, applied settlement thresholds using each channel's currency, and initialized session extensions without mutating previously created methods. Preserved each existing subscription's authorized currency during reuse and renewal, and defaulted new subscription offers to mainnet, with `testnet: true` selecting Moderato.

Reduced package size by removing duplicated HTML bundle literals from generated type declarations.

Pinned workspace viem dependencies to the public `2.57.1` release and required `viem >=2.57.1` as a peer dependency.
