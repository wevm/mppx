---
'mppx': patch
---

Fixed `mppx/validation` so it no longer imports the CLI, which pulled in the CLI's bundled `incur` dependency and failed to load from npm. `validate()` and `validateStream()` now take an optional `payment` validator; without one, payment checks are reported as skipped. `mppx validate` passes its own.

Moved shared modules so lower layers no longer import higher ones: the HTML payment-page infrastructure and x402 wire helpers now live under `src/internal`, and the MCP SDK server transport lives under `src/server`. Public entry points are unchanged.
