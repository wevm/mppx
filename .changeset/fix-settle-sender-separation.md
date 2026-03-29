---
'mppx': patch
---

Fixed `settleOnChain` and `closeOnChain` to use the payee account as
`msg.sender` instead of the fee payer when submitting fee-sponsored
transactions. Previously, `sendFeePayerTx` used the fee payer as both
sender and gas sponsor, causing the escrow contract to revert with
`NotPayee()`. Added `account` option to `tempo.settle()` so callers can
specify the signing account separately from the fee payer.
