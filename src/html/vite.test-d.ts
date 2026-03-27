import { describe, test } from 'vp/test'

import * as StripeMethods from '../stripe/Methods.js'
import * as TempoMethods from '../tempo/Methods.js'
import mppx from './vite.js'

describe('html vite', () => {
  test('challenge request derives from method schema', () => {
    mppx({
      method: TempoMethods.charge,
      entry: 'form',
      output: 'dist/html.gen.ts',
      realm: 'dev.local',
      challenge: {
        description: 'Tempo payment',
        digest: 'sha-256=abc',
        expires: undefined,
        meta: { traceId: 'tempo-dev' },
        request: {
          amount: '1',
          currency: '0x20c0000000000000000000000000000000000001',
          decimals: 6,
        },
      },
    })

    mppx({
      method: StripeMethods.charge,
      output: 'dist/html.gen.ts',
      challenge: {
        request: {
          amount: '10',
          currency: 'usd',
          decimals: 2,
          networkId: 'acct_dev',
          paymentMethodTypes: ['card'],
        },
      },
    })
  })

  test('challenge request rejects another method schema', () => {
    mppx({
      method: TempoMethods.charge,
      output: 'dist/html.gen.ts',
      challenge: {
        request: {
          amount: '10',
          currency: 'usd',
          decimals: 2,
          // @ts-expect-error -- stripe-specific fields should not typecheck for tempo charge
          networkId: 'acct_dev',
        },
      },
    })
  })
})
