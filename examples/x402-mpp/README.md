# x402 + mpp

A Hono server that serves mpp, x402, and composed mpp-or-x402 payment routes from one process.

```bash
npx gitpick wevm/mppx/examples/x402-mpp
pnpm i
pnpm dev
```

## Routes

| Route         | Payment options                  | Challenge headers                      |
| ------------- | -------------------------------- | -------------------------------------- |
| `/api/mpp`    | MPP (Tempo)                      | `WWW-Authenticate`                     |
| `/api/x402`   | MPP (EVM) or x402 exact          | `WWW-Authenticate`, `PAYMENT-REQUIRED` |
| `/api/paid`   | MPP (Tempo or EVM) or x402 exact | `WWW-Authenticate`, `PAYMENT-REQUIRED` |
| `/api/health` | free healthcheck                 | none                                   |

The x402 route defaults to the free no-key `https://facilitator.x402.rs` testnet facilitator.
Set `X402_FACILITATOR_URL` to use another facilitator.

No-key facilitators that currently advertise Base Sepolia v2 exact support:

| Facilitator URL                   | Notes                                 |
| --------------------------------- | ------------------------------------- |
| `https://facilitator.x402.rs`     | Default free x402.rs test facilitator |
| `https://x402.org/facilitator`    | Free x402 test facilitator            |
| `https://pay.openfacilitator.io`  | Hosted OpenFacilitator endpoint       |
| `https://facilitator.openx402.ai` | Hosted OpenX402 endpoint              |

## Test both clients

With the server running:

```bash
MPP_PRIVATE_KEY=0x... X402_PRIVATE_KEY=0x... pnpm client
```

`MPP_PRIVATE_KEY` is optional for mpp-only runs. When it is omitted, the client creates a Tempo
testnet account and funds it from the public faucet. For x402 runs, set `MPP_PRIVATE_KEY` or
`X402_PRIVATE_KEY`, then fund the derived address with Base Sepolia USDC from
[Circle's public testnet faucet](https://faucet.circle.com/). `X402_PRIVATE_KEY` overrides
`MPP_PRIVATE_KEY` when both are set.

The client calls `/api/mpp`, `/api/x402`, then calls `/api/paid` once through mpp and once through x402.
Set `FLOW=mpp` or `FLOW=x402` to run one protocol path at a time:

```bash
FLOW=mpp pnpm client
FLOW=x402 X402_PRIVATE_KEY=0x... pnpm client
```

## Inspect x402

Inspect x402 requirements without paying:

```bash
curl -i http://localhost:5173/api/x402
curl -i http://localhost:5173/api/paid
```

These example endpoints are GET routes. EVM-backed handlers emit both `WWW-Authenticate` and
`PAYMENT-REQUIRED` for GET and body-bearing requests. This app invokes the core `mppx/server`
handlers directly from Hono, so it does not attach an automatic route scope. Standard x402 clients
can pay when no digest, scope, opaque value, or metadata binding is required. Routes using
`mppx/hono` are automatically scoped and require a client that implements the mppx route-binding
extension.

## Test with purl

Install the current purl CLI:

```bash
brew install stripe/purl/purl
purl wallet add
```

`purl v0.2.7` recognizes MPP and x402 challenges:

```bash
purl inspect http://localhost:5173/api/mpp
purl inspect http://localhost:5173/api/x402
purl inspect http://localhost:5173/api/paid
```

The composed route can be exercised with an EVM key:

```bash
purl --private-key 0x... http://localhost:5173/api/paid
```

purl releases before [stripe/purl#102](https://github.com/stripe/purl/pull/102) may select the
Payment-auth EVM challenge before the x402 challenge on `/api/x402` or `/api/paid`, then exit
with `EVM provider expects x402 PaymentRequirements`.
