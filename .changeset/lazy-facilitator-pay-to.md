---
'mppx': patch
---

Added `tempoX402()` at `mppx/x402/tempo`, which wires the official x402 SDK to the Tempo x402 facilitator: `tempo.route({ price })` fills `payTo` with the facilitator's deposit address and `extra.tempoSettlement` with the payout address.

An EVM charge with an `x402.facilitator` can now leave out `recipient`: it reads the facilitator's published `payTo` on the first challenge, caches it and refreshes it every 5 minutes, so a rotated deposit address is picked up without a restart. A payment naming a replaced address still verifies for 10 minutes, but only if this server issued that address, and a rejected payment always gets a challenge for the current one. `recipient` also accepts a function, called for each challenge, and `evm.facilitatorPayToResolver()` builds a cached resolver with a custom `ttl`, `grace` or `timeout`. A composed route leaves out an offer whose recipient can't be read (`OfferUnavailableError`) and advertises the others. Discovery documents don't publish a lazy recipient.
