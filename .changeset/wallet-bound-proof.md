---
'mppx': patch
---

Bound Tempo zero-amount proof credentials to the payer wallet. The EIP-712 `Proof` typed-data now includes an `account` field (domain version bumped to `3`), so a proof signature commits to a specific payer address and can no longer be replayed against a different account — including across an access key authorized for multiple accounts. Exposed the canonical proof contract via `tempo.Proof` (`types`, `domain`, `primaryType`, `message`, `typedData`, `hash`) and added deterministic conformance vectors covering the wallet-binding property.
