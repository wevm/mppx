import { createClient, custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'
import { defineToken } from 'viem/tokens'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Mppx from '../../server/Mppx.js'
import * as Store from '../../Store.js'
import { tokens } from '../internal/defaults.js'
import * as Proof from '../internal/proof.js'
import type * as ChannelStore from '../session/server/ChannelStore.js'
import * as Settlement from '../session/server/Settlement.js'
import * as Ws from '../session/server/Ws.js'
import { tempo } from './Methods.js'

const recipient = '0x1234567890123456789012345678901234567890'
const rpc = vi.fn(() => {
  throw new Error('Unexpected RPC call')
})
const client = createClient({ chain: tempoChain, transport: custom({ request: rpc }) })
const config = { recipient, getClient: () => client } as const
const secretKey = 'test-secret-key-test-secret-key-32'

test.each([false, true])('proof replay preserves explicit store policy: %s', async (withStore) => {
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const proofClient = createClient({
    chain: tempoChain,
    transport: custom(
      {
        request: async () => {
          throw new Error('No contract signature')
        },
      },
      { retryCount: 0 },
    ),
  })
  const server = Mppx.create({
    methods: [
      tempo({
        ...config,
        getClient: () => proofClient,
        ...(withStore ? { store: Store.memory() } : {}),
      }),
    ],
    secretKey,
  })
  const route = server.charge({ amount: '0' })
  const offered = await route(new Request('https://example.com'))
  if (offered.status !== 402) throw new Error('Expected payment offers')
  for (const challenge of Challenge.fromResponseList(offered.challenge)) {
    const signature = await account.signTypedData({
      domain: Proof.domain(4217),
      types: Proof.types,
      primaryType: 'Proof',
      message: Proof.message({
        account: account.address,
        challengeId: challenge.id,
        realm: challenge.realm,
      }),
    })
    const authorization = Credential.serialize(
      Credential.from({
        challenge,
        payload: { signature, type: 'proof' },
        source: `did:pkh:eip155:4217:${account.address}`,
      }),
    )
    const pay = () => route(new Request('https://example.com', { headers: { authorization } }))
    expect((await pay()).status).toBe(200)
    expect((await pay()).status).toBe(withStore ? 402 : 200)
  }
})

test.each(
  [
    { decimals: 6, order: [6, 8] },
    { decimals: 8, order: [6, 8] },
    { decimals: 6, order: [8, 6] },
    { decimals: 8, order: [8, 6] },
    { decimals: 6, order: [6] },
    { decimals: 8, order: [8] },
  ].flatMap((scenario) => [false, true].map((individual) => ({ ...scenario, individual }))),
)(
  'session helpers use $decimals decimals with token order $order',
  async ({ decimals, order, individual }) => {
    const token = decimals === 6 ? tokens.usdc : tokens.ousd
    const currencies = order.map((precision) =>
      defineToken({
        addresses: { 4217: precision === 6 ? tokens.usdc : tokens.ousd },
        currency: 'USD',
        decimals: precision,
      }),
    )
    const settle = vi.spyOn(Settlement, 'maybeSettleScheduled').mockResolvedValue('0x01')
    const serve = vi.spyOn(Ws, 'serve').mockResolvedValue()
    try {
      const server = Mppx.create({
        methods: [
          individual
            ? tempo.session({ ...config, currencies, settlementSchedule: { amount: '1' } })
            : tempo({ ...config, currencies, settlementSchedule: { amount: '1' } }),
        ],
        secretKey,
      })
      const threshold = 10n ** BigInt(decimals)
      const channel = {
        backend: 'precompile',
        chainId: 4217,
        token: `0x${token.slice(2).toUpperCase()}`,
        spent: threshold - 1n,
        settledOnChain: 0n,
        units: 1,
        createdAt: new Date().toISOString(),
        highestVoucher: { cumulativeAmount: threshold },
      } as ChannelStore.State
      await server.tempo.session.settleScheduled(channel)
      expect(settle).not.toHaveBeenCalled()
      channel.spent = threshold
      expect(await server.tempo.session.settleScheduled(channel)).toBe('0x01')
      expect(settle).toHaveBeenLastCalledWith(
        expect.objectContaining({ schedule: { amount: threshold }, channel }),
      )
      await server.tempo.session.serveWebSocket({} as never)
      const onChargeCommitted = serve.mock.calls[0]![0].onChargeCommitted!
      settle.mockClear()
      channel.spent = threshold - 1n
      await onChargeCommitted(channel)
      expect(settle).not.toHaveBeenCalled()
      channel.spent = threshold
      await onChargeCommitted(channel)
      expect(settle).toHaveBeenLastCalledWith(
        expect.objectContaining({ schedule: { amount: threshold }, channel }),
      )
      const channelId = `0x${'01'.repeat(32)}` as const
      const websocketStore = serve.mock.calls[0]![0].store
      if (!('updateChannel' in websocketStore)) throw new Error('Expected channel store')
      await websocketStore.updateChannel(channelId, () => ({ ...channel, channelId }))
      const settlementStore = settle.mock.calls[0]![0].store
      expect(await settlementStore.getChannel(channelId)).toMatchObject({ token: channel.token })

      const independent = Mppx.create({
        methods: [
          individual ? tempo.session({ ...config, currencies }) : tempo({ ...config, currencies }),
        ],
        secretKey,
      })
      await independent.tempo.session.serveWebSocket({} as never)
      const independentStore = serve.mock.calls[1]![0].store
      if (!('getChannel' in independentStore)) throw new Error('Expected channel store')
      expect(await independentStore.getChannel(channelId)).toBeNull()
      settle.mockClear()
      for (const unknown of [
        { ...channel, chainId: 42431 },
        { ...channel, token: recipient } as const,
      ]) {
        expect(() => server.tempo.session.settleScheduled(unknown)).toThrow(
          'Channel currency is not configured',
        )
        expect(() => onChargeCommitted(unknown)).toThrow('Channel currency is not configured')
      }
      expect(settle).not.toHaveBeenCalled()

      const error = new Error('Settlement unavailable')
      settle.mockRejectedValue(error)
      await expect(server.tempo.session.settleScheduled(channel)).rejects.toBe(error)
      await expect(onChargeCommitted(channel)).resolves.toBeUndefined()
    } finally {
      settle.mockRestore()
      serve.mockRestore()
    }
  },
)

describe('common currency offers', () => {
  test('exports common as an alias and supports omitted parameters', () => {
    expect(tempo.common).toBe(tempo)
    expect(tempo().map((method) => [method.intent, method.defaults?.currency])).toEqual([
      ['charge', tokens.ousd],
      ['session', tokens.ousd],
      ['charge', tokens.usdc],
      ['session', tokens.usdc],
    ])
  })

  test.each([
    { parameters: {}, currencies: [tokens.ousd, tokens.usdc] },
    { parameters: { currency: tokens.usdc }, currencies: [tokens.usdc] },
    {
      parameters: { currencies: [tokens.usdc, tokens.ousd] },
      currencies: [tokens.usdc, tokens.ousd],
    },
    {
      parameters: { currencies: [tokens.ousd, tokens.ousd.toLowerCase()] },
      currencies: [tokens.ousd],
    },
  ])('advertises charge and session offers for $parameters', async ({ parameters, currencies }) => {
    const mppx = Mppx.create({ methods: [tempo.common({ ...config, ...parameters })], secretKey })
    for (const handler of [
      mppx.charge({ amount: '1.25' }),
      mppx.session({ amount: '1.25', unitType: 'request' }),
    ]) {
      const response = await handler(new Request('https://example.com/paid'))
      expect(response.status).toBe(402)
      if (response.status !== 402) throw new Error('Expected payment offers')
      const challenges = Challenge.fromResponseList(response.challenge)
      expect(challenges.map((challenge) => challenge.request.currency)).toEqual(currencies)
      expect(new Set(challenges.map((challenge) => challenge.id)).size).toBe(currencies.length)
      for (const challenge of challenges) {
        expect(challenge.request.amount).toBe('1250000')
        expect(challenge.request.recipient).toBe(recipient)
        expect(challenge.request.methodDetails).toMatchObject({ chainId: 4217 })
      }
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  test.each([{ testnet: true }, { chainId: 42431 }])(
    'testnet defaults advertise OUSD then pathUSD for %s',
    async (parameters) => {
      const mppx = Mppx.create({ methods: [tempo.common({ recipient, ...parameters })], secretKey })
      for (const handler of [
        mppx.charge({ amount: '1' }),
        mppx.session({ amount: '1', unitType: 'request' }),
      ]) {
        const result = await handler(new Request('https://example.com/paid'))
        if (result.status !== 402) throw new Error('Expected payment offers')
        const challenges = Challenge.fromResponseList(result.challenge)
        expect(challenges.map(({ request }) => request.currency)).toEqual([
          tokens.ousd,
          tokens.pathUsd,
        ])
        expect(new Set(challenges.map(({ id }) => id)).size).toBe(2)
        for (const { request } of challenges)
          expect(request).toMatchObject({
            amount: '1000000',
            recipient,
            methodDetails: { chainId: 42431 },
          })
      }
    },
  )

  test('resolves callable token definitions and normalizes amounts per token', async () => {
    const token = defineToken({ addresses: { 4217: tokens.ousd }, currency: 'USD', decimals: 8 })
    const mppx = Mppx.create({
      methods: [tempo.common({ ...config, currencies: [token, tokens.usdc] })],
      secretKey,
    })
    const result = await mppx.charge({ amount: '1.25' })(new Request('https://example.com/paid'))
    if (result.status !== 402) throw new Error('Expected payment offers')
    expect(
      Challenge.fromResponseList(result.challenge).map(({ request }) => [
        request.currency,
        request.amount,
      ]),
    ).toEqual([
      [tokens.ousd, '125000000'],
      [tokens.usdc, '1250000'],
    ])
  })

  test('keeps explicit single-currency configuration', () => {
    const [charge, session] = tempo.common({ ...config, currency: tokens.usdc })
    expect(charge.intent).toBe('charge')
    expect(session.intent).toBe('session')
    expect(charge.defaults?.currency).toBe(tokens.usdc)
    expect(session.defaults?.currency).toBe(tokens.usdc)
  })

  test('preserves session management extensions on composed named handlers', () => {
    const mppx = Mppx.create({ methods: [tempo.common(config)], secretKey })
    expect(mppx.tempo.session.serveWebSocket).toBeTypeOf('function')
    expect(mppx.tempo.session.settleScheduled).toBeTypeOf('function')
  })

  test('rejects conflicting currency options at runtime', () => {
    expect(() =>
      tempo.common({ ...config, currency: tokens.usdc, currencies: [tokens.ousd] } as never),
    ).toThrow('Specify either `currency` or `currencies`, not both.')
  })
})

describe('individual intent currency offers', () => {
  test.each([
    { intent: 'charge', parameters: {}, expected: [tokens.ousd, tokens.usdc], chainId: 4217 },
    { intent: 'session', parameters: {}, expected: [tokens.ousd, tokens.usdc], chainId: 4217 },
    { intent: 'subscription', parameters: {}, expected: [tokens.ousd, tokens.usdc], chainId: 4217 },
    ...(['charge', 'session', 'subscription'] as const).flatMap((intent) => [
      {
        intent,
        parameters: { testnet: true },
        expected: [tokens.ousd, tokens.pathUsd],
        chainId: 42431,
      },
      {
        intent,
        parameters: { chainId: 42431 },
        expected: [tokens.ousd, tokens.pathUsd],
        chainId: 42431,
      },
      {
        intent,
        parameters: { currencies: [tokens.usdc, tokens.ousd] },
        expected: [tokens.usdc, tokens.ousd],
        chainId: 4217,
      },
      { intent, parameters: { currency: tokens.usdc }, expected: [tokens.usdc], chainId: 4217 },
      { intent, parameters: { currencies: [tokens.ousd] }, expected: [tokens.ousd], chainId: 4217 },
    ]),
  ])(
    '$intent offers $expected for $parameters',
    async ({ intent, parameters, expected, chainId }) => {
      const accessKey = {
        accessKeyAddress: '0x1234567890123456789012345678901234567890',
        keyType: 'secp256k1',
      } as const
      const config = {
        recipient,
        getClient: () =>
          createClient({
            chain: { ...tempoChain, id: chainId },
            transport: custom({ request: rpc }),
          }),
      } as const
      const methods =
        intent === 'charge'
          ? tempo.charge({ ...config, ...parameters })
          : intent === 'session'
            ? tempo.session({ ...config, ...parameters })
            : tempo.subscription({
                ...config,
                ...parameters,
                resolve: async () => ({ key: 'user:plan', accessKey }),
              })
      const offers = [methods].flat()
      expect(offers.map((method) => method.intent)).toEqual(expected.map(() => intent))
      const server = Mppx.create({ methods: [methods], secretKey })
      const options = {
        amount: '1.25',
        unitType: 'request',
        periodCount: 1,
        periodUnit: 'day',
        subscriptionExpires: new Date(
          Math.floor(Date.now() / 1000) * 1000 + 86400_000 * 30,
        ).toISOString(),
      } as const
      const handler =
        intent === 'charge'
          ? server.charge(options)
          : intent === 'session'
            ? server.session(options)
            : server.subscription(options)
      const response = await handler(new Request('https://example.com/paid'))
      if (response.status !== 402) throw new Error('Expected currency offers')
      const challenges = Challenge.fromResponseList(response.challenge)
      expect(challenges.map(({ request }) => String(request.currency).toLowerCase())).toEqual(
        expected.map((currency) => currency.toLowerCase()),
      )
      expect(new Set(challenges.map(({ id }) => id)).size).toBe(expected.length)
      for (const { request } of challenges) {
        expect(request.amount).toBe('1250000')
        expect(request.methodDetails).toMatchObject({ chainId })
      }
    },
  )

  test.each(['charge', 'session', 'subscription'] as const)(
    '%s rejects conflicting or empty lists',
    (intent) => {
      const create = (parameters: object) => {
        const factory = tempo[intent] as (parameters: never) => unknown
        return factory({
          ...config,
          resolve: async () => ({ key: 'user:plan' }),
          ...parameters,
        } as never)
      }
      expect(() => create({ currency: tokens.usdc, currencies: [tokens.ousd] })).toThrow(
        'Specify either',
      )
      expect(() => create({ currencies: [] })).toThrow('No accepted USD currencies')
    },
  )
})
