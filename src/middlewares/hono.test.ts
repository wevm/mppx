import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Challenge, Credential, Method, Receipt, z } from 'mppx'
import {
  Mppx as Mppx_client,
  session as sessionIntent,
  tempo as tempo_client,
  x402 as x402_client,
} from 'mppx/client'
import { Mppx, discovery, payment } from 'mppx/hono'
import { Mppx as ServerMppx, tempo as tempo_server, x402 as x402_server } from 'mppx/server'
import { paymentRequiredHeader, paymentResponseHeader, type PaymentPayload } from 'mppx/x402'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

function createServer(app: Hono) {
  return new Promise<Http.TestServer>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve(
        Http.wrapServer(server as unknown as import('node:http').Server, {
          port: info.port,
          url: `http://localhost:${info.port}`,
        }),
      )
    })
  })
}

const secretKey = 'test-secret-key'

describe('payment', () => {
  test('short-circuits management responses', async () => {
    let handlerRan = false
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: () =>
        new Response(null, {
          headers: { 'Payment-Receipt': 'management-receipt' },
          status: 204,
        }),
    })

    const app = new Hono()
    app.get('/', payment(intent as any, {} as any), (c) => {
      handlerRan = true
      return c.json({ data: 'content' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(204)
    expect(response.headers.get('Payment-Receipt')).toBe('management-receipt')
    expect(await response.text()).toBe('')
    expect(handlerRan).toBe(false)

    server.close()
  })

  test('copies transport-specific success headers', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) =>
        new Response(response?.body ?? null, {
          headers: {
            ...(response ? Object.fromEntries(response.headers) : {}),
            'PAYMENT-RESPONSE': 'x402-response',
          },
          status: response?.status ?? 200,
        }),
    })

    const app = new Hono()
    app.get('/', payment(intent as any, {} as any), (c) => c.json({ data: 'content' }))

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('PAYMENT-RESPONSE')).toBe('x402-response')

    server.close()
  })
})

const scopeMethod = Method.toServer(
  Method.from({
    name: 'mock',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  }),
  {
    async verify() {
      return {
        method: 'mock',
        reference: 'tx-mock',
        status: 'success' as const,
        timestamp: new Date().toISOString(),
      }
    },
  },
)

function createScopeHarness() {
  return Mppx.create({
    methods: [scopeMethod],
    realm: 'api.example.com',
    secretKey,
  })
}

function createChargeHarness(feePayer: boolean) {
  const mppx = Mppx.create({
    methods: [
      tempo_server.charge({
        getClient: () => client,
        currency: asset,
        account: accounts[0],
        ...(feePayer ? { feePayer: true } : {}),
      }),
    ],
    secretKey,
  })

  const { fetch } = Mppx_client.create({
    polyfill: false,
    methods: [
      tempo_client.charge({
        account: accounts[1],
        getClient: () => client,
      }),
    ],
  })

  return { fetch, mppx }
}

describe('charge', () => {
  test('returns 402 when no credential', async () => {
    const { mppx } = createChargeHarness(false)

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(false)

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ fortune: 'You will be rich' })

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(true)

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })

  test('serves /openapi.json via auto discovery', async () => {
    const { mppx } = createChargeHarness(false)

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))
    discovery(app, mppx, { auto: true, info: { title: 'Auto API', version: '2.0.0' } })

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/openapi.json`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')

    const body = (await response.json()) as Record<string, any>
    expect(body.info).toEqual({ title: 'Auto API', version: '2.0.0' })
    expect(body.paths['/'].get['x-payment-info'].offers[0]).toMatchObject({
      amount: '1000000',
      currency: asset,
      intent: 'charge',
      method: 'tempo',
    })

    server.close()
  })

  test('serves tempo and x402 from one Hono endpoint', async () => {
    const transaction = `0x${'2'.repeat(64)}` as const
    const payments = ServerMppx.create({
      methods: [
        tempo_server.charge({
          account: accounts[0],
          currency: asset,
          getClient: () => client,
          recipient: accounts[0].address,
        }),
        x402_server.exact({
          config: {
            asset: x402_server.assets.baseSepolia.USDC,
            facilitator: {
              async verify(paymentPayload: PaymentPayload) {
                return {
                  isValid: true,
                  payer: payerOf(paymentPayload),
                }
              },
              async settle(paymentPayload: PaymentPayload) {
                return {
                  network: paymentPayload.accepted.network,
                  payer: payerOf(paymentPayload),
                  success: true,
                  transaction,
                }
              },
            },
            payTo: accounts[0].address,
          },
        }),
      ],
      secretKey,
    })

    const route = payments.compose(
      ['tempo/charge', { amount: '0', chainId: client.chain!.id }],
      ['x402/exact', { amount: '10000' }],
    )

    const app = new Hono()
    app.get('/paid', async (c) => {
      const result = await route(c.req.raw)
      if (result.status === 402) return result.challenge
      return result.withReceipt(c.json({ data: 'paid' }))
    })

    const server = await createServer(app)
    const challenge = await globalThis.fetch(`${server.url}/paid`)
    expect(challenge.status).toBe(402)
    expect(challenge.headers.get('WWW-Authenticate')).toContain('Payment')
    expect(challenge.headers.get(paymentRequiredHeader)).toBeTruthy()

    const tempoPayment = Mppx_client.create({
      methods: [
        tempo_client.charge({
          account: accounts[0],
          getClient: () => client,
        }),
      ],
      polyfill: false,
    })
    const tempoResponse = await tempoPayment.fetch(`${server.url}/paid`)
    expect(tempoResponse.status).toBe(200)
    expect(await tempoResponse.json()).toEqual({ data: 'paid' })
    expect(tempoResponse.headers.get('Payment-Receipt')).toBeTruthy()

    const x402Payment = Mppx_client.create({
      methods: [
        x402_client.exact({
          account: accounts[0],
        }),
      ],
      polyfill: false,
    })
    const x402Response = await x402Payment.fetch(`${server.url}/paid`)
    expect(x402Response.status).toBe(200)
    expect(await x402Response.json()).toEqual({ data: 'paid' })
    expect(x402Response.headers.get(paymentResponseHeader)).toBeTruthy()

    server.close()
  })
})

function payerOf(paymentPayload: PaymentPayload): string {
  if ('authorization' in paymentPayload.payload) return paymentPayload.payload.authorization.from
  return paymentPayload.payload.permit2Authorization.from
}

describe('scope binding', () => {
  const scopeOpts = {
    amount: '1',
    currency: '0x0000000000000000000000000000000000000001',
    decimals: 6,
    recipient: '0x0000000000000000000000000000000000000002',
  }

  test('auto-injects route scope and blocks same-economics replay across routes', async () => {
    const mppx = createScopeHarness()

    const app = new Hono()
    app.get('/alpha/:id', mppx.charge(scopeOpts), (c) => c.json({ route: 'alpha' }))
    app.get('/beta/:id', mppx.charge(scopeOpts), (c) => c.json({ route: 'beta' }))

    const server = await createServer(app)
    const challengeResponse = await fetch(`${server.url}/alpha/1`)
    expect(challengeResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(challengeResponse)
    expect(challenge.opaque).toBe('eyJfbXBweF9zY29wZSI6IkdFVCAvYWxwaGEvOmlkIn0')

    const credential = Credential.from({ challenge, payload: { token: 'valid' } })
    const replay = await fetch(`${server.url}/beta/1`, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    expect(replay.status).toBe(402)
    server.close()
  })

  test('manual scope overrides adapter-derived route scope', async () => {
    const mppx = createScopeHarness()

    const app = new Hono()
    app.get('/alpha/:id', mppx.charge({ ...scopeOpts, scope: 'shared-scope' }), (c) =>
      c.json({ route: 'alpha' }),
    )
    app.get('/beta/:id', mppx.charge({ ...scopeOpts, scope: 'shared-scope' }), (c) =>
      c.json({ route: 'beta' }),
    )

    const server = await createServer(app)
    const challengeResponse = await fetch(`${server.url}/alpha/1`)
    expect(challengeResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(challengeResponse)
    expect(challenge.opaque).toBe('eyJfbXBweF9zY29wZSI6InNoYXJlZC1zY29wZSJ9')

    const credential = Credential.from({ challenge, payload: { token: 'valid' } })
    const replay = await fetch(`${server.url}/beta/2`, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ route: 'beta' })
    server.close()
  })
})

describe('session', () => {
  let escrowContract: Address

  function createSessionHarness(feePayer: boolean) {
    const mppx = Mppx.create({
      methods: [
        tempo_server.session({
          getClient: () => client,
          account: accounts[0],
          currency: asset,
          escrowContract,
          ...(feePayer ? { feePayer: accounts[1] } : {}),
        } as any),
      ],
      secretKey,
    })

    const { fetch } = Mppx_client.create({
      polyfill: false,
      methods: [
        sessionIntent({
          account: accounts[2],
          deposit: '10',
          getClient: () => client,
        }),
      ],
    })

    return { fetch, mppx }
  }

  beforeAll(async () => {
    escrowContract = await deployEscrow()
    await fundAccount({ address: accounts[1].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[1].address, token: asset })
    await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[2].address, token: asset })
  })

  test('returns 402 when no credential', async () => {
    const { mppx } = createSessionHarness(false)

    const app = new Hono()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(false)

    const app = new Hono()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(true)

    const app = new Hono()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })
})
