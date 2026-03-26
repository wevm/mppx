import { defineConfig } from 'vite'

import * as Methods from '../../stripe/Methods.js'
import { createTokenPathname } from '../../stripe/server/internal/createTokenPathname.js'
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
          const { paymentMethod, amount, currency, expiresAt } = JSON.parse(
            Buffer.concat(chunks).toString(),
          ) as { paymentMethod: string; amount: string; currency: string; expiresAt: number }

          const body = new URLSearchParams({
            payment_method: paymentMethod,
            'usage_limits[currency]': currency,
            'usage_limits[max_amount]': amount,
            'usage_limits[expires_at]': expiresAt.toString(),
          })

          const response = await fetch(
            'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens',
            {
              method: 'POST',
              headers: {
                Authorization: `Basic ${btoa(`${secretKey}:`)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body,
            },
          )

          res.setHeader('Content-Type', 'application/json')
          if (!response.ok) {
            const error = (await response.json()) as { error: { message: string } }
            res.statusCode = 500
            res.end(JSON.stringify({ error: error.error.message }))
            return
          }

          const { id: spt } = (await response.json()) as { id: string }
          res.end(JSON.stringify({ spt }))
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
