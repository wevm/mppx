import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

import * as Challenge from '../../../../Challenge.js'
import * as Credential from '../../../../Credential.js'
import * as Method from '../../../../Method.js'
import * as Request from '../../../../server/Request.js'
import * as z from '../../../../zod.js'
import mppx from '../../../vite.js'

const testFormMethod = Method.from({
  intent: 'charge',
  name: 'test',
  schema: {
    credential: {
      payload: z.object({
        code: z.string().check(z.regex(/^test-payment-code-[a-z0-9-]+$/, 'Invalid payment code')),
        serverToken: z.string().check(z.regex(/^server-ok-[a-z0-9-]+$/, 'Invalid server token')),
        type: z.literal('code'),
      }),
    },
    request: z.object({
      amount: z.string(),
    }),
  },
})

const seenCredentials = new Set<string>()

export default defineConfig({
  plugins: [
    attachmentOnVerifiedPayment(),
    mppx({
      method: testFormMethod,
      entry: 'form',
      output: './html.gen.ts',
      challenge: {
        request: { amount: '1000' },
        description: 'Test form payment',
      },
      verify({ credential }) {
        verifyCredentialOnce(credential)
      },
    }),
  ],
})

function attachmentOnVerifiedPayment(): Plugin {
  return {
    name: 'mppx:test-download-success',
    apply: 'serve',
    configureServer(server) {
      // oxlint-disable-next-line no-async-endpoint-handlers
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/' || url.searchParams.get('download') !== '1') return next()
        if (!req.headers.accept?.includes('text/html')) return next()

        try {
          const request = Request.fromNodeListener(req, res)
          const credential = Credential.fromRequest(request)
          const parsedPayload = testFormMethod.schema.credential.payload.safeParse(
            credential.payload,
          )
          if (!Challenge.verify(credential.challenge, { secretKey: 'mppx-dev-secret' }))
            return next()
          if (!parsedPayload.success) return next()
          verifyCredentialOnce(credential)

          res.statusCode = 200
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('Content-Disposition', 'attachment; filename="protected.txt"')
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Protected response')
          return
        } catch {}

        next()
      })
    },
  }
}

function verifyCredentialOnce(credential: Credential.Credential) {
  const serialized = Credential.serialize(credential)
  if (seenCredentials.has(serialized)) throw new Error('Payment has already been processed.')
  seenCredentials.add(serialized)
}
