import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../Challenge.js'
import * as Assets from '../evm/Assets.js'
import { charge } from '../evm/client/Charge.js'
import { resolvePlugin, selectChallenge } from './internal.js'
import { evm } from './plugins/evm.js'

const account = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const challenge = Challenge.from({
  id: 'payment-policy',
  realm: 'example.com',
  method: 'evm',
  intent: 'charge',
  request: {
    amount: '2000000',
    currency: Assets.baseSepolia.USDC.address,
    recipient: '0x2222222222222222222222222222222222222222',
    methodDetails: { chainId: 84532, credentialTypes: ['authorization'] },
  },
})

describe('configured payment policies', () => {
  test.each([{ maxAmount: '1' }, { maxAtomicAmount: '1000000' }])(
    'preserves the configured cap %j through challenge selection',
    async (limits) => {
      const signTypedData = vi.fn(async () => '0x1234' as const)
      const method = charge({
        account: { ...account, signTypedData },
        currencies: [Assets.baseSepolia.USDC],
        ...limits,
      })
      const selected = selectChallenge([challenge], { methods: [[method]] })
      expect(selected?.method).toBe(method)
      expect(selected?.plugin).toBeUndefined()
      await expect(selected!.method!.createCredential({ challenge, context: {} })).rejects.toThrow(
        /amount exceeds max/,
      )
      expect(signTypedData).not.toHaveBeenCalled()
    },
  )

  test('retains explicit plugin precedence', () => {
    const method = charge({ account, maxAmount: '1' })
    const plugin = evm()
    expect(resolvePlugin(challenge, { methods: [method], plugins: [plugin] })).toEqual({ plugin })
  })

  test('falls back to the built-in plugin without a matching configured method', () => {
    expect(resolvePlugin(challenge).plugin?.method).toBe('evm')
    expect(resolvePlugin({ ...challenge, method: 'unknown' })).toEqual({})
  })
})
