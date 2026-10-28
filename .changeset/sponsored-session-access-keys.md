---
'mppx': patch
---

Removed the `allowKeyAuthorization` fee-payer policy: sponsored transactions may now carry a `keyAuthorization`, so an access key can open a fee-sponsored session (or pay a sponsored charge) in the transaction that installs it. Sponsor exposure stays bounded by `maxGas` and `maxTotalFee`.
