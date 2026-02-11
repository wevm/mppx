import { Challenge, Credential, Intent, Mcp, MethodIntent, Receipt } from 'mpay'
import { Mpay, Transport, tempo } from 'mpay/client'
import { Mpay as Mpay_server, tempo as tempo_server } from 'mpay/server'
import { MethodIntents } from 'mpay/tempo'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

afterEach(() => {
  Mpay.restore()
})

describe('Mpay.create', () => {
  test('default', () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    expect(mpay.methods).toHaveLength(2)
    expect(mpay.methods[0]?.method).toBe('tempo')
    expect(mpay.methods[0]?.name).toBe('charge')
    expect(mpay.methods[1]?.method).toBe('tempo')
    expect(mpay.methods[1]?.name).toBe('session')
    expect(mpay.transport.name).toBe('http')
    expect(typeof mpay.createCredential).toBe('function')
    expect(typeof mpay.fetch).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
      transport: Transport.mcp(),
    })

    expect(mpay.transport.name).toBe('mcp')
  })

  test('behavior: with multiple methods', () => {
    const stripeCharge = MethodIntent.fromIntent(Intent.charge, {
      method: 'stripe',
      schema: {
        credential: {
          payload: MethodIntents.charge.schema.credential.payload,
        },
      },
    })
    const stripeMethod = MethodIntent.toClient(stripeCharge, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xstripe', type: 'transaction' },
        })
      },
    })

    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client }), stripeMethod],
    })

    expect(mpay.methods).toHaveLength(3)
    expect(mpay.methods[0]?.method).toBe('tempo')
    expect(mpay.methods[1]?.method).toBe('tempo')
    expect(mpay.methods[2]?.method).toBe('stripe')
  })
})

describe('createCredential', () => {
  test('behavior: routes to correct method based on challenge', async () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    const challenge = Challenge.fromIntent(MethodIntents.charge, {
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

    const credential = await mpay.createCredential(response)

    expect(credential).toMatch(/^Payment /)

    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.challenge.method).toBe('tempo')
  })

  test('behavior: throws when method not found', async () => {
    const mpay = Mpay.create({
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

    await expect(mpay.createCredential(response)).rejects.toThrow(
      'No method intent found for "unknown.charge". Available: tempo.charge, tempo.session',
    )
  })

  test('behavior: routes to correct method with multiple methods', async () => {
    const stripeCharge = MethodIntent.fromIntent(Intent.charge, {
      method: 'stripe',
      schema: {
        credential: {
          payload: MethodIntents.charge.schema.credential.payload,
        },
      },
    })

    const stripe = MethodIntent.toClient(stripeCharge, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xstripe', type: 'transaction' },
        })
      },
    })

    const mpay = Mpay.create({
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

    const credential = await mpay.createCredential(response)
    const parsed = Credential.deserialize(credential)

    expect(parsed.payload).toEqual({ signature: '0xstripe', type: 'transaction' })
    expect(parsed.challenge.method).toBe('stripe')
  })

  test('behavior: passes context to createCredential', async () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ getClient: () => client })],
    })

    const challenge = Challenge.fromIntent(MethodIntents.charge, {
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

    const credential = await mpay.createCredential(response, { account: accounts[1] })

    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.source).toContain(accounts[1].address)
  })

  test('behavior: works without context when account provided at creation', async () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    const challenge = Challenge.fromIntent(MethodIntents.charge, {
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

    const credential = await mpay.createCredential(response)
    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
  })

  test('behavior: with mcp transport', async () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
      transport: Transport.mcp(),
    })

    const challenge = Challenge.fromIntent(MethodIntents.charge, {
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

    const credential = await mpay.createCredential(mcpResponse)
    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.challenge.method).toBe('tempo')
  })
})

const server = Mpay_server.create({
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
    const mpay = Mpay.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mpay_server.toNodeListener(
        server.charge({
          amount: '1',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await mpay.fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    httpServer.close()
  })

  test('behavior: passes through non-402 responses', async () => {
    const mpay = Mpay.create({
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

    const response = await mpay.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')

    httpServer.close()
  })

  test('behavior: supports context', async () => {
    const mpay = Mpay.create({
      polyfill: false,
      methods: [
        tempo({
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mpay_server.toNodeListener(
        server.charge({
          amount: '1',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await mpay.fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    httpServer.close()
  })
})

describe('polyfill', () => {
  test('default: polyfills globalThis.fetch', async () => {
    const originalFetch = globalThis.fetch

    Mpay.create({
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(globalThis.fetch).not.toBe(originalFetch)

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mpay_server.toNodeListener(
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

    Mpay.create({
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

    Mpay.create({
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(globalThis.fetch).not.toBe(originalFetch)

    Mpay.restore()

    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('behavior: noop when not polyfilled', () => {
    const originalFetch = globalThis.fetch

    Mpay.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    Mpay.restore()

    expect(globalThis.fetch).toBe(originalFetch)
  })
})
