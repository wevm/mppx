import { defineConfig } from 'vite'

import * as Method from '../../../../Method.js'
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

export default defineConfig({
  plugins: [
    mppx({
      method: testFormMethod,
      entry: 'form',
      output: './html.gen.ts',
      challenge: {
        request: { amount: '1000' },
        description: 'Test form payment',
      },
    }),
  ],
})
