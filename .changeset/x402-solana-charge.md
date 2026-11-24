---
'mppx': minor
---

The x402 middlewares now offer a native `solana/charge` MPP challenge beside a Solana `exact` requirement, as they already do for EVM `exact`. The client's partially signed transfer is verified and settled through the route's x402 facilitator, with the facilitator as fee payer, so one route takes x402 and MPP payments on Solana. Clients pay it with `@solana/mpp`'s `solana.charge`.
