import type { Account } from 'viem'
import { expectTypeOf, test } from 'vp/test'

import { charge } from './Charge.js'

const account = {} as Account
const hash = `0x${'1'.repeat(64)}` as `0x${string}`
const signature = `0x${'2'.repeat(130)}` as `0x${string}`

test('fillPayload return type follows configured pull mode', () => {
  charge({
    account,
    fillPayload(parameters) {
      expectTypeOf(parameters.mode).toEqualTypeOf<'pull'>()
      expectTypeOf(parameters.request.nonceKey).toEqualTypeOf<'expiring' | undefined>()
      return { signature, type: 'transaction' }
    },
    mode: 'pull',
  })

  charge({
    account,
    // @ts-expect-error pull payload hooks must return a transaction signature.
    fillPayload: async () => ({ hash, type: 'hash' }),
    mode: 'pull',
  })
})

test('fillPayload return type follows configured push mode', () => {
  charge({
    account,
    fillPayload(parameters) {
      expectTypeOf(parameters.mode).toEqualTypeOf<'push'>()
      return { hash, type: 'hash' }
    },
    mode: 'push',
  })

  charge({
    account,
    // @ts-expect-error push payload hooks must return a transaction hash.
    fillPayload: async () => ({ signature, type: 'transaction' }),
    mode: 'push',
  })
})

test('fillPayload may return either result when mode is selected at runtime', () => {
  charge({
    account,
    fillPayload({ mode }) {
      if (mode === 'push') return { hash, type: 'hash' }
      return { signature, type: 'transaction' }
    },
  })
})
