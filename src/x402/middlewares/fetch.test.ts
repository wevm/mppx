import { x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { Hono } from 'hono'
import { Challenge } from 'mppx'
import { evm, Fetch } from 'mppx/client'
import { mpp as honoMpp } from 'mppx/x402/hono'
import { mpp as nextMpp, mppProxy } from 'mppx/x402/next'
import { NextRequest } from 'next/server.js'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as PaymentRequest from '../../PaymentRequest.js'
import * as ChallengeBrand from '../internal/ChallengeBrand.js'
import * as Types from '../Types.js'

const network = 'eip155:84532' as const
const recipient = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const route = {
  accepts: {
    maxTimeoutSeconds: 15,
    network,
    payTo: recipient,
    price: '$0.01',
    scheme: 'exact',
  },
} as const
const method = evm.charge({
  account,
  authorization: { name: 'USDC', version: '2' },
  maxAtomicAmount: '1000000',
})

function createResourceServer() {
  const facilitator = {
    async getSupported() {
      return {
        extensions: [],
        kinds: [
          { extra: { assetTransferMethod: 'eip3009' }, network, scheme: 'exact', x402Version: 2 },
        ],
        signers: {},
      }
    },
    async settle() {
      return { network, payer: account.address, success: true, transaction: `0x${'1'.repeat(64)}` }
    },
    async verify() {
      return { isValid: true, payer: account.address }
    },
  }
  return new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
}

function createFetch(framework: 'hono' | 'next'): typeof globalThis.fetch {
  const server = createResourceServer()
  if (framework === 'hono') {
    const app = new Hono()
    app.use(
      honoMpp({ 'GET /api/data': route }, server, {
        secretKey: 'test-secret-key-test-secret-key-32',
      }),
    )
    app.get('/api/data', (context) => context.json({ framework }))
    return (input, init) => Promise.resolve(app.fetch(new Request(input, init)))
  }
  const handler = nextMpp(() => Response.json({ framework }), route, server, {
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  return (input, init) => Promise.resolve(handler(new NextRequest(new Request(input, init))))
}

describe.each(['hono', 'next'] as const)('x402 %s compatibility', (framework) => {
  test('negotiates and completes an MPP charge', async () => {
    const rawFetch = createFetch(framework)
    const unpaid = await rawFetch(new Request('https://example.com/api/data'))
    expect(unpaid.status).toBe(402)
    expect(unpaid.headers.get('WWW-Authenticate')).toContain('Payment')
    expect(unpaid.headers.get(Types.paymentRequiredHeader)).toBeTruthy()
    const challenges = Challenge.fromResponseList(unpaid)
    expect(
      challenges
        .filter((challenge) => !ChallengeBrand.is(challenge))
        .map((challenge) => challenge.method),
    ).toEqual(['tempo', 'evm'])
    const challenge = challenges[0]!
    const timeout = new Date(challenge.expires!).getTime() - Date.now()
    expect(timeout).toBeGreaterThan(14_000)
    expect(timeout).toBeLessThanOrEqual(15_000)

    const fetch = Fetch.from({
      fetch: rawFetch,
      methods: [method],
      orderChallenges: (candidates) =>
        [...candidates].sort(
          (a, b) => Number(ChallengeBrand.is(a.challenge)) - Number(ChallengeBrand.is(b.challenge)),
        ),
    })
    const response = await fetch('https://example.com/api/data')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ framework })
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()

    const x402Fetch = Fetch.from({
      fetch: rawFetch,
      methods: [method],
      orderChallenges: (candidates) =>
        [...candidates].sort(
          (a, b) => Number(ChallengeBrand.is(b.challenge)) - Number(ChallengeBrand.is(a.challenge)),
        ),
    })
    const x402Response = await x402Fetch('https://example.com/api/data')
    expect(x402Response.status).toBe(200)
    expect(x402Response.headers.get(Types.paymentResponseHeader)).toBeTruthy()
  })
})

describe('MPP compatibility challenges', () => {
  test('binds Tempo and source-chain credentials to the x402 resource', async () => {
    const app = new Hono()
    app.use(
      honoMpp({ 'GET /a': route, 'GET /b': route }, createResourceServer(), {
        secretKey: 'test-secret-key-test-secret-key-32',
      }),
    )
    app.get('/a', (context) => context.json({ route: 'a' }))
    app.get('/b', (context) => context.json({ route: 'b' }))

    const challengeScopes = async (path: string) => {
      const response = await app.fetch(new Request(`https://example.com${path}`))
      return Challenge.fromResponseList(response)
        .filter((challenge) => !ChallengeBrand.is(challenge))
        .map((challenge) => ({ method: challenge.method, opaque: challenge.opaque }))
    }

    const scopeA = PaymentRequest.serialize({ _mppx_scope: 'https://example.com/a' })
    const scopeB = PaymentRequest.serialize({ _mppx_scope: 'https://example.com/b' })
    await expect(challengeScopes('/a')).resolves.toEqual([
      { method: 'tempo', opaque: scopeA },
      { method: 'evm', opaque: scopeA },
    ])
    await expect(challengeScopes('/b')).resolves.toEqual([
      { method: 'tempo', opaque: scopeB },
      { method: 'evm', opaque: scopeB },
    ])
  })

  test('forwards Next.js route context through MPP and x402 payments', async () => {
    const handler = nextMpp(
      async (_request, context: { params: Promise<{ slug: string }> }) =>
        Response.json(await context.params),
      route,
      createResourceServer(),
      { secretKey: 'test-secret-key-test-secret-key-32' },
    )
    const rawFetch: typeof globalThis.fetch = (input, init) =>
      Promise.resolve(
        handler(new NextRequest(new Request(input, init)), {
          params: Promise.resolve({ slug: 'premium' }),
        }),
      )

    for (const preferMpp of [true, false]) {
      const fetch = Fetch.from({
        fetch: rawFetch,
        methods: [method],
        orderChallenges: (candidates) =>
          [...candidates].sort((a, b) =>
            preferMpp
              ? Number(ChallengeBrand.is(a.challenge)) - Number(ChallengeBrand.is(b.challenge))
              : Number(ChallengeBrand.is(b.challenge)) - Number(ChallengeBrand.is(a.challenge)),
          ),
      })

      const response = await fetch('https://example.com/api/data')

      expect(await response.json()).toEqual({ slug: 'premium' })
    }
  })
})

describe('mppProxy', () => {
  test('uses Next.js proxy continuation semantics for both protocols', async () => {
    const proxy = mppProxy({ 'GET /api/data': route }, createResourceServer(), {
      secretKey: 'test-secret-key-test-secret-key-32',
    })
    const rawFetch: typeof globalThis.fetch = (input, init) =>
      Promise.resolve(proxy(new NextRequest(new Request(input, init))))

    const mppFetch = Fetch.from({
      fetch: rawFetch,
      methods: [method],
      orderChallenges: (candidates) =>
        [...candidates].sort(
          (a, b) => Number(ChallengeBrand.is(a.challenge)) - Number(ChallengeBrand.is(b.challenge)),
        ),
    })
    const mppResponse = await mppFetch('https://example.com/api/data')
    expect(mppResponse.headers.get('x-middleware-next')).toBe('1')
    expect(mppResponse.headers.get('Payment-Receipt')).toBeTruthy()

    const x402Fetch = Fetch.from({
      fetch: rawFetch,
      methods: [method],
      orderChallenges: (candidates) =>
        [...candidates].sort(
          (a, b) => Number(ChallengeBrand.is(b.challenge)) - Number(ChallengeBrand.is(a.challenge)),
        ),
    })
    const x402Response = await x402Fetch('https://example.com/api/data')
    expect(x402Response.headers.get('x-middleware-next')).toBe('1')
    expect(x402Response.headers.get(Types.paymentResponseHeader)).toBeTruthy()
  })
})
