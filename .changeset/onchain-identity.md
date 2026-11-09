---
'mppx': patch
---

Added `mppx/extensions/identity/onchain`, with payment checks that require the payer to be allowed by an onchain registry: `Onchain.Server.registry` for a contract such as a KYC allowlist, and `Onchain.Server.coinbase` for Coinbase Verifications on Base.
