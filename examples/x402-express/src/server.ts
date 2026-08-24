import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { x402ResourceServer } from '@x402/express'
import express from 'express'
import { withMpp } from 'mppx/x402/express'

const network = 'eip155:84532' as const
const port = Number(process.env.PORT ?? 3000)
const payTo = (process.env.PAY_TO ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as `0x${string}`
const secretKey = process.env.MPP_SECRET_KEY

if (!secretKey) throw new Error('Set MPP_SECRET_KEY to at least 32 random bytes.')

const facilitator = new HTTPFacilitatorClient({
  url: process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
})
const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
const routes = {
  'GET /api/data': {
    accepts: [
      {
        network,
        payTo,
        price: '$0.01',
        scheme: 'exact',
      },
    ],
    description: 'Premium data access',
    mimeType: 'application/json',
  },
} satisfies RoutesConfig

const app = express()

app.use(
  withMpp(routes, resourceServer, {
    secretKey,
  }),
)

app.get('/api/data', (_request, response) => {
  response.json({ data: 'premium content' })
})

app.listen(port, () => {
  console.log(`x402 + MPP Express server listening on http://localhost:${port}`)
  console.log(`inspect its combined challenge: curl -i http://localhost:${port}/api/data`)
})
