import { defineConfig } from 'vite'

import * as Methods from '../../stripe/Methods.js'
import { createTokenPathname, createTokenResponse } from '../../stripe/server/Charge.js'
import mppx from '../vite.js'

export default defineConfig({
  plugins: [
    {
      name: 'stripe-spt',
      configureServer(server) {
        // oxlint-disable-next-line no-async-endpoint-handlers
        server.middlewares.use(createTokenPathname, async (req, res) => {
          const secretKey = process.env.VITE_STRIPE_SECRET_KEY
          if (!secretKey) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'VITE_STRIPE_SECRET_KEY not set in .env' }))
            return
          }

          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const response = await createTokenResponse({
            request: new Request(`http://localhost${req.url ?? createTokenPathname}`, {
              body: Buffer.concat(chunks),
              method: req.method ?? 'POST',
            }),
            secretKey,
          })

          for (const [key, value] of response.headers) res.setHeader(key, value)
          res.statusCode = response.status
          res.end(await response.text())
        })
      },
    },
    mppx({
      method: Methods.charge,
      output: '../../stripe/server/internal/html.gen.ts',
      challenge: {
        request: {
          amount: '10',
          currency: 'usd',
          decimals: 2,
          networkId: 'acct_dev',
          paymentMethodTypes: ['card'],
        },
        description: 'Test payment',
      },
      config: {
        createTokenUrl: createTokenPathname,
        publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY ?? 'pk_test_example',
      },
    }),
  ],
})
