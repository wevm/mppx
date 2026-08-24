# Add MPP to an x402 Express server

This example starts with the official x402 Express setup and adds MPP without replacing its route
table, resource server, facilitator, hooks, verification, or settlement.

The integration is the middleware import plus one secret:

```diff
 import { ExactEvmScheme } from '@x402/evm/exact/server'
-import { paymentMiddleware, x402ResourceServer } from '@x402/express'
+import { x402ResourceServer } from '@x402/express'
+import { mpp } from 'mppx/x402/express'

 const resourceServer = new x402ResourceServer(facilitator).register(
   'eip155:84532',
   new ExactEvmScheme(),
 )

 app.use(
-  paymentMiddleware(routes, resourceServer),
+  mpp(routes, resourceServer, {
+    secretKey: process.env.MPP_SECRET_KEY!,
+  }),
 )
```

The same route accepts both standard x402 `PAYMENT-SIGNATURE` credentials and MPP
`Authorization: Payment` credentials.

## Run it

```bash
npx gitpick wevm/mppx/examples/x402-express
pnpm i
MPP_SECRET_KEY=$(openssl rand -base64 32) pnpm dev
```

Inspect both challenges on the unpaid response:

```bash
curl -i http://localhost:3000/api/data
```

To complete payments, set a Base Sepolia private key funded with USDC from
[Circle's testnet faucet](https://faucet.circle.com/):

```bash
PRIVATE_KEY=0x... pnpm client
```

Every unpaid request advertises both payment options. The client selects a compatible challenge
from the combined response and retries with one payment credential.

`PAY_TO`, `PORT`, `BASE_URL`, and `X402_FACILITATOR_URL` can be overridden. The checked-in recipient
is for local testnet use only; production deployments should set `PAY_TO` explicitly.

For a native mppx server that composes MPP and x402 payment methods directly, see
[`../x402-mpp`](../x402-mpp/).
