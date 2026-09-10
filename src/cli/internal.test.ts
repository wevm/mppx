import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../Challenge.js'
import * as Assets from '../evm/Assets.js'
import { charge } from '../evm/client/Charge.js'
import { assertSamePaymentRequest, resolvePlugin, selectChallenge } from './internal.js'
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

test('preserves the configured method selected by challenge filtering', () => {
  const first = { ...charge({ account }), canHandleChallenge: () => false }
  const second = { ...charge({ account }), canHandleChallenge: () => true }
  const config = { methods: [first, second] }
  expect(selectChallenge([challenge], config)?.method).toBe(second)
  expect(resolvePlugin(challenge, config).method).toBe(second)
  expect(resolvePlugin(challenge, { methods: [first] })).toEqual({})
  expect(selectChallenge([challenge], { methods: [first] })).toBeUndefined()
})

describe('retry approval', () => {
  test('allows a refreshed ID and expiry for the same payment', () => {
    expect(() =>
      assertSamePaymentRequest(challenge, {
        ...challenge,
        id: 'retry',
        expires: '2099-01-01T00:00:00Z',
      }),
    ).not.toThrow()
  })
  test.each([
    { realm: 'another.example' },
    { request: { ...challenge.request, amount: '9000000' } },
    { request: { ...challenge.request, recipient: account.address } },
    { request: { ...challenge.request, methodDetails: { chainId: 1 } } },
  ])('rejects changed payment fields %j', (changes) => {
    expect(() => assertSamePaymentRequest(challenge, { ...challenge, ...changes })).toThrow(
      'Payment request changed on retry',
    )
  })
})
