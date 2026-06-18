---
'mppx': patch
---

Hardened confirmed Tempo subscription settlement against T6 (TIP-1028) receive policies. Activation and renewal payments that wait for confirmation now verify that a TIP-20 `TransferWithMemo` log credits the intended recipient for the expected amount with the generated settlement memo, instead of trusting transaction success alone. Transfers held by a receiver's receive policy (redirected to `ReceivePolicyGuard`) are now rejected rather than treated as paid, and the memo binding excludes unrelated transfer effects in the same receipt. Documented that the optimistic `waitForConfirmation: false` mode cannot prove recipient credit under T6.
