---
'mppx': patch
---

Added opt-in Tempo [TIP-1034](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1034.md) precompile support for payment-channel sessions.

The default `tempo.session(...)` method continued to use the existing session backend. Applications opted into the new precompile-backed flow explicitly by using `tempo.precompile.session(...)` on the client and `tempo.precompile.Server.session(...)` on the server.

```ts
import { Mppx, tempo } from 'mppx/client'

const client = Mppx.create({
  methods: [tempo.precompile.session({ account, maxDeposit: '10' })],
})
```

```ts
import { Mppx, tempo } from 'mppx/server'

const server = Mppx.create({
  methods: [
    tempo.precompile.Server.session({
      amount: '1',
      chainId,
      currency,
      recipient,
      store,
      unitType: 'request',
    }),
  ],
})
```

This added channel ID, expiring nonce hash, voucher, ABI calldata, open/top-up validation, descriptor persistence, credential payload parsing, client credential builder, session manager, server verification, and server-driven fee-payer settle/close helpers for TIP20EscrowChannel precompile channels. It also changed precompile chain helpers to use `*OnChain` names, updated amount APIs to accept plain bigint values while validating uint96 bounds at encoding boundaries, updated precompile voucher signing inputs to match legacy session voucher signing, aligned precompile client session modules with the legacy client layout, and hardened precompile channel validation, atomic store updates, voucher-signing compatibility, finalized channel bookkeeping, and devnet precompile integration test setup.
