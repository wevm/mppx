import { Challenge, Credential, Mcp, Method, Receipt } from 'mppx'
import { Mppx, Transport, tempo } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Methods } from 'mppx/tempo'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

afterEach(() => {
  Mppx.restore()
})

describe('Mppx.create', () => {
  test('default', () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    expect(mppx.methods).toHaveLength(2)
    expect(mppx.methods[0]?.name).toBe('tempo')
    expect(mppx.methods[0]?.intent).toBe('charge')
    expect(mppx.methods[1]?.name).toBe('tempo')
    expect(mppx.methods[1]?.intent).toBe('session')
    expect(mppx.transport.name).toBe('http')
    expect(typeof mppx.createCredential).toBe('function')
    expect(typeof mppx.fetch).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
      transport: Transport.mcp(),
    })

    expect(mppx.transport.name).toBe('mcp')
  })

  test('behavior: with multiple methods', () => {
    const stripeCharge = Method.from({
      name: 'stripe',
      intent: 'charge',
      schema: {
        credential: {
          payload: Methods.charge.schema.credential.payload,
        },
        request: Methods.charge.schema.request,
      },
    })
    const stripeMethod = Method.toClient(stripeCharge, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xstripe', type: 'transaction' },
        })
      },
    })

    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client }), stripeMethod],
    })

    expect(mppx.methods).toHaveLength(3)
    expect(mppx.methods[0]?.name).toBe('tempo')
    expect(mppx.methods[1]?.name).toBe('tempo')
    expect(mppx.methods[2]?.name).toBe('stripe')
  })
})

describe('createCredential', () => {
  test('behavior: routes to correct method based on challenge', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    const challenge = Challenge.fromIntent(Methods.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mppx.createCredential(response)

    expect(credential).toMatch(/^Payment /)

    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.challenge.method).toBe('tempo')
  })

  test('behavior: throws when method not found', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    const challenge = Challenge.from({
      id: 'test-id',
      realm,
      method: 'unknown',
      intent: 'charge',
      request: { amount: '1000', currency: '0x1234' },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    await expect(mppx.createCredential(response)).rejects.toThrow(
      'No method found for "unknown.charge". Available: tempo.charge, tempo.session',
    )
  })

  test('behavior: routes to correct method with multiple methods', async () => {
    const stripeCharge = Method.from({
      name: 'stripe',
      intent: 'charge',
      schema: {
        credential: {
          payload: Methods.charge.schema.credential.payload,
        },
        request: Methods.charge.schema.request,
      },
    })

    const stripe = Method.toClient(stripeCharge, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xstripe', type: 'transaction' },
        })
      },
    })

    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client }), stripe],
    })

    const stripeChallenge = Challenge.from({
      id: 'stripe-challenge-id',
      realm,
      method: 'stripe',
      intent: 'charge',
      request: {
        amount: '2000',
        currency: '0xabcd',
        recipient: '0xefgh',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(stripeChallenge),
      },
    })

    const credential = await mppx.createCredential(response)
    const parsed = Credential.deserialize(credential)

    expect(parsed.payload).toEqual({ signature: '0xstripe', type: 'transaction' })
    expect(parsed.challenge.method).toBe('stripe')
  })

  test('behavior: passes context to createCredential', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ getClient: () => client })],
    })

    const challenge = Challenge.fromIntent(Methods.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mppx.createCredential(response, { account: accounts[1] })

    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.source).toContain(accounts[1].address)
  })

  test('behavior: works without context when account provided at creation', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    const challenge = Challenge.fromIntent(Methods.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mppx.createCredential(response)
    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
  })

  test('behavior: with mcp transport', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
      transport: Transport.mcp(),
    })

    const challenge = Challenge.fromIntent(Methods.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const mcpResponse: Mcp.Response = {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: Mcp.paymentRequiredCode,
        message: 'Payment Required',
        data: {
          httpStatus: 402,
          challenges: [challenge],
        },
      },
    }

    const credential = await mppx.createCredential(mcpResponse)
    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.challenge.method).toBe('tempo')
  })
})

const server = Mppx_server.create({
  methods: [
    tempo_server.charge({
      currency: asset,
      getClient: () => client,
      recipient: accounts[0].address,
    }),
  ],
})

describe('fetch', () => {
  test('default: handles 402 automatically', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    httpServer.close()
  })

  test('behavior: passes through non-402 responses', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(200)
      res.end('OK')
    })

    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')

    httpServer.close()
  })

  test('behavior: supports context', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        tempo({
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await mppx.fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    httpServer.close()
  })
})

describe('polyfill', () => {
  test('default: polyfills globalThis.fetch', async () => {
    const originalFetch = globalThis.fetch

    Mppx.create({
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(globalThis.fetch).not.toBe(originalFetch)

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')

    httpServer.close()
  })

  test('behavior: polyfill false does not mutate globalThis.fetch', () => {
    const originalFetch = globalThis.fetch

    Mppx.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(globalThis.fetch).toBe(originalFetch)
  })
})

describe('restore', () => {
  test('default: restores original fetch', () => {
    const originalFetch = globalThis.fetch

    Mppx.create({
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(globalThis.fetch).not.toBe(originalFetch)

    Mppx.restore()

    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('behavior: noop when not polyfilled', () => {
    const originalFetch = globalThis.fetch

    Mppx.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    Mppx.restore()

    expect(globalThis.fetch).toBe(originalFetch)
  })
})
