import { Mppx, x402 } from 'mppx/server'
import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vp/test'

import { x402 as clientX402 } from '../client/index.js'

const secretKey = 'test-secret'

describe('x402 public interface', () => {
  test('server exact accepts known assets without transfer metadata', () => {
    const mppx = Mppx.create({
      methods: [
        x402.exact({
          config: {
            currency: x402.assets.base.USDC,
            facilitator: {
              settle: async () => ({
                network: 'eip155:8453',
                success: true,
                transaction: `0x${'1'.repeat(64)}`,
              }),
              verify: async () => ({ isValid: true }),
            },
            recipient: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          },
        }),
      ],
      secretKey,
    })

    expectTypeOf(mppx.x402.exact).toBeFunction()
    expectTypeOf(mppx.x402.exact({ amount: '10000' })).toBeFunction()
  })

  test('client exact exposes account config and policies', () => {
    const method = clientX402.exact({
      account: {} as Account,
      assets: ['0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
      maxAmount: '10000',
      networks: ['eip155:84532'],
    })

    expectTypeOf(method.intent).toEqualTypeOf<'exact'>()
    expectTypeOf(method.name).toEqualTypeOf<'x402'>()
  })
})
