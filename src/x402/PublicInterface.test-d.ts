import { evm, Mppx } from 'mppx/server'
import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vp/test'

import { evm as clientEvm } from '../client/index.js'

const secretKey = 'test-secret'

describe('x402 public interface', () => {
  test('server evm charge accepts known assets without transfer metadata', () => {
    const mppx = Mppx.create({
      methods: [
        evm.charge({
          currency: evm.assets.base.USDC,
          facilitator: {
            settle: async () => ({
              network: 'eip155:8453',
              success: true,
              transaction: `0x${'1'.repeat(64)}`,
            }),
            verify: async () => ({ isValid: true }),
          },
          recipient: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        }),
      ],
      secretKey,
    })

    expectTypeOf(mppx.evm.charge).toBeFunction()
    expectTypeOf(mppx.evm.charge({ amount: '0.01' })).toBeFunction()
  })

  test('client evm charge exposes account config and policies', () => {
    const method = clientEvm.charge({
      account: {} as Account,
      currencies: [clientEvm.assets.baseSepolia.USDC],
      maxAmount: '0.01',
      networks: ['eip155:84532'],
    })

    expectTypeOf(method.intent).toEqualTypeOf<'charge'>()
    expectTypeOf(method.name).toEqualTypeOf<'evm'>()
  })
})
