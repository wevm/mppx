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
        code: z.string(),
        type: z.string(),
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
      output: './html.gen.ts',
      challenge: {
        request: { amount: '1000' },
        description: 'Test form payment',
      },
    }),
  ],
})
