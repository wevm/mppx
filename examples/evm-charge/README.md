# EVM Charge Example

This example protects `GET /api/data` with an `evm/charge` ERC-20 payment.

Set:

```bash
export MPPX_PRIVATE_KEY=0x...
export MPPX_RPC_URL=https://...
export MPPX_CHAIN_ID=1
export MPPX_TOKEN_ADDRESS=0x...
export MPPX_TOKEN_DECIMALS=6
```

Then run:

```bash
pnpm dev
```
