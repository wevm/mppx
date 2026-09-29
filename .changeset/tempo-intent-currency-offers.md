---
'mppx': minor
---

Changed `tempo.charge()`, `tempo.session()`, and `tempo.subscription()` to return ordered method groups with OUSD first and USDC.e as the mainnet fallback, or OUSD then pathUSD on Moderato. Added `currencies` to these factories and deprecated their singular `currency` configuration. Explicit currency configuration continued to restrict acceptance to that currency.

Existing `methods: [tempo.charge(options)]` configuration remained supported. Code inspecting a single method directly must now destructure the returned group; explicit composition should use configured handlers such as `mppx.tempo.charge`. Wire Challenges and per-handler currency overrides remained singular.

Shared session storage and settlement dispatch across accepted currencies, and preserved each existing subscription's authorized currency during reuse and renewal. Defaulted new subscription offers to mainnet consistently with the other public Tempo factories; `testnet: true` selected Moderato.
