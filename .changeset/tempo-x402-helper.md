---
'mppx': patch
---

Added `tempoX402()` at `mppx/x402/tempo`, which wires the official x402 SDK to the Tempo x402 facilitator: `tempo.route({ price })` fills `payTo` with the facilitator's deposit address (from `GET /supported`) and `extra.tempoSettlement` with the payout address, and a route can pay out to its own `payoutAddress`. It throws at startup on a missing API key or a missing or malformed payout address.
