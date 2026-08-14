# MPP revenue to Peer Cash

A merchant server that accepts Base USDC over MPP, counts successful settlements, and prepares
an unsigned Peer Cash plan once confirmed revenue reaches a threshold.

The public MPP route and the cash-out planner are separate listeners. The planner binds to
`127.0.0.1` and never accepts private keys, signs, or broadcasts. The merchant wallet that receives
the MPP revenue keeps custody and decides whether to submit the returned transactions.

## Setup

```bash
npx gitpick wevm/mppx/examples/peer-cash
pnpm i

export MPPX_RECIPIENT=0xMerchantWallet
export X402_FACILITATOR_URL=https://your-facilitator.example
export MPP_SECRET_KEY=replace-with-at-least-32-random-characters
export PEER_CASH_PLATFORM=revolut
export PEER_CASH_CURRENCY=USD
export PEER_CASH_PAYEE=your-handle
export PEER_CASH_THRESHOLD_USDC=10

pnpm dev
```

Use a facilitator that supports Base mainnet USDC. The recipient must be the merchant-controlled
Base wallet that will sign any Peer Cash transactions.

## Payment and cash-out flow

Pay the MPP resource with an EVM-capable client:

```bash
MPPX_PRIVATE_KEY=0x... pnpm mppx http://localhost:5173/api/report
```

Inspect confirmed, unreserved revenue on the local admin listener:

```bash
curl http://127.0.0.1:5174/status
```

After the threshold is reached, prepare a cash-out for all available revenue:

```bash
curl -X POST http://127.0.0.1:5174/cashout \
  -H 'content-type: application/json' \
  -d '{}'
```

Pass `{"amountUsdc":"5.25"}` to prepare a smaller amount. The response contains unsigned
transactions and same-index step descriptions. Review them, then sign and submit them with the
recipient wallet.

The example deduplicates successful MPP receipts and reserves planned amounts in memory so a
second request cannot prepare the same revenue again. A production service must persist settlement,
reservation, transaction, and deposit state before exposing an equivalent operator endpoint.
