---
'mppx': patch
---

Added `tempoX402()` at `mppx/x402/tempo`, which wires the official x402 SDK to the Tempo x402 facilitator: `tempo.route({ price })` fills `payTo` with the facilitator's deposit address and `extra.tempoSettlement` with the payout address.

An EVM charge with an `x402.facilitator` can now leave out `recipient`: it reads the facilitator's published `payTo` on the first challenge, caches it and refreshes it every 5 minutes, so a rotated deposit address is picked up without a restart. A payment naming a replaced address still verifies for 10 minutes, but only if this server issued that address. `recipient` also accepts a function, and `evm.facilitatorPayToResolver()` builds a resolver with a custom `ttl`, `grace` or `timeout`. A composed route leaves out an offer whose recipient can't be read (`OfferUnavailableError`) instead of failing.
