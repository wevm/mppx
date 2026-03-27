import * as path from 'node:path'

import { defineConfig } from 'vite'

import * as Methods from '../../stripe/Methods.js'
import { createTokenResponse } from '../../stripe/server/internal/sharedPaymentToken.js'
import { support, supportPlaceholderOrigin, supportRequestUrl } from '../internal/constants.js'
import mppx from '../vite.js'

const useStripeMock = process.env.MPPX_MOCK_STRIPE === '1'
const mockStripePath = path.resolve(import.meta.dirname, '../test/mockStripe.ts')

export default defineConfig({
  plugins: [
    {
      name: 'mock-stripe-module',
      resolveId(id) {
        if (useStripeMock && id === '@stripe/stripe-js/pure') return mockStripePath
      },
    },
    {
      name: 'stripe-spt',
      configureServer(server) {
        // oxlint-disable-next-line no-async-endpoint-handlers
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? '/', supportPlaceholderOrigin)
          if (
            url.searchParams.get(support.kind) !== support.action ||
            url.searchParams.get(support.actionName) !== 'createToken'
          )
            return next()

          if (useStripeMock) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ spt: 'spt_mock' }))
            return
          }

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
            request: new Request(`${supportPlaceholderOrigin}${req.url ?? '/'}`, {
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
      actions: {
        createToken: supportRequestUrl({ kind: support.action, name: 'createToken', url: '/' }),
      },
      config: {
        publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY ?? 'pk_test_example',
      },
    }),
  ],
})
