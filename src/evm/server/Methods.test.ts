import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defineToken, ousd, usdc } from 'viem/tokens'
import { expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as ClientMppx from '../../client/Mppx.js'
import * as Mppx from '../../server/Mppx.js'
import { evm as evmClient } from '../client/Methods.js'
import { evm } from './Methods.js'

const secretKey = 'test-secret-key-test-secret-key-32'
const recipient = '0x1234567890123456789012345678901234567890'
const reference = `0x${'11'.repeat(32)}`
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

test.each([1, 8453])(
  'resolves OUSD and USDC on chain %s and settles only the chosen offer',
  async (chainId) => {
    // Fixture domains exercise routing; deployment-specific domains must be supplied by integrators.
    const currencies = [ousd, usdc].map((token, index) =>
      evm.assets.fromToken(token, {
        chainId,
        transfer: { type: 'eip3009', name: `Fixture ${index}`, version: '1' },
      }),
    )
    const settlements = [vi.fn(async () => ({ reference })), vi.fn(async () => ({ reference }))]
    const successes = [vi.fn(), vi.fn()]
    const methods = evm({ chainId, currencies, recipient, settle: settlements[0]! }).map(
      (method, index) => ({ ...method, onPaymentSuccess: successes[index] }),
    )
    // Distinct settlers exercise method identity, not just the wire name/intent.
    const second = evm({
      chainId,
      currencies: [currencies[1]!],
      recipient,
      settle: settlements[1]!,
    })[0]
    methods[1] = { ...second, onPaymentSuccess: successes[1] }
    const server = Mppx.create({ methods: [methods], secretKey })
    const payer = ClientMppx.create({
      methods: [evmClient({ account, currencies })],
      polyfill: false,
    })

    for (const route of [server.charge({ amount: '1' }), server.evm.charge({ amount: '1' })]) {
      const offered = await route(new Request('https://example.com/paid'))
      if (offered.status !== 402) throw new Error('Expected payment offers')
      const challenges = Challenge.fromResponseList(offered.challenge)
      expect(challenges.map(({ request }) => request.currency)).toEqual(
        currencies.map(({ address }) => getAddress(address)),
      )
      for (let index = 0; index < challenges.length; index++) {
        const challenge = challenges[index]!
        const credential = await payer.createCredential(
          new Response(null, {
            status: 402,
            headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
          }),
        )
        const result = await route(
          new Request('https://example.com/paid', { headers: { Authorization: credential } }),
        )
        expect(result.status).toBe(200)
        expect(settlements[index]).toHaveBeenCalledTimes(1)
        expect(settlements[1 - index]).not.toHaveBeenCalled()
        expect(successes[index]).toHaveBeenCalledTimes(1)
        expect(successes[1 - index]).not.toHaveBeenCalled()
        for (const fn of [...settlements, ...successes]) fn.mockClear()
      }
    }
  },
)

test('supports one currency, preserves ordering, and removes duplicate chain/address pairs', () => {
  const methods = evm({
    chainId: 8453,
    currencies: [usdc, ousd, usdc],
    authorization: { name: 'Fixture', version: '1' },
    recipient,
    settle: async () => ({ reference }),
  })
  expect(methods.map((method) => method.defaults?.currency)).toEqual([
    getAddress(usdc(8453).address),
    getAddress(ousd(8453).address),
  ])
  expect(
    evm({ currencies: [evm.assets.base.USDC], recipient, settle: async () => ({ reference }) }),
  ).toHaveLength(1)
})

test('filters unavailable chains and non-USD token definitions', () => {
  const other = defineToken({
    addresses: { 8453: ousd(8453).address },
    currency: 'EUR',
    decimals: 6,
  })
  const methods = evm({
    chainId: 8453,
    currencies: [evm.assets.baseSepolia.USDC, other, evm.assets.base.USDC],
    recipient,
    settle: async () => ({ reference }),
  })
  expect(methods).toHaveLength(1)
  expect(methods[0].defaults?.currency).toBe(getAddress(usdc(8453).address))
})

test.each([
  { currencies: [], error: 'No accepted EVM currencies' },
  { currencies: [ousd], chainId: 99999, error: 'No accepted EVM currencies' },
  { currencies: [ousd], error: 'require `chainId`' },
  { currencies: [ousd], chainId: 8453, error: 'requires `authorization` metadata' },
])('rejects invalid configuration: $error', ({ error, ...config }) => {
  expect(() => evm({ ...config, recipient, settle: async () => ({ reference }) })).toThrow(error)
})

test('rejects both currency configuration fields', () => {
  expect(() => evm({ currency: usdc, currencies: [ousd], recipient } as never)).toThrow(
    'Specify either',
  )
})

test('retains the same token address on distinct networks', () => {
  const currencies = [1, 8453].map((chainId) =>
    evm.assets.define({
      address: ousd(8453).address,
      decimals: 6,
      network: evm.assets.toNetwork(chainId),
      transfer: { type: 'eip3009', name: 'Fixture', version: '1' },
    }),
  )
  const methods = evm({ currencies, recipient, settle: async () => ({ reference }) })
  expect(methods.map((method) => method.defaults?.chainId)).toEqual([1, 8453])
})
