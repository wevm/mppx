import { Challenge, Credential, Intent, MethodIntent, z } from 'mpay'
import { Mpay, Transport, tempo } from 'mpay/server'
import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const method = tempo.charge({
  getClient: () => client,
})

describe('create', () => {
  test('default', () => {
    const handler = Mpay.create({ methods: [method], realm, secretKey })

    expect(handler.realm).toBe(realm)
    expect(handler.transport.name).toBe('http')
    expect(typeof handler.charge).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const handler = Mpay.create({ methods: [method], realm, secretKey, transport: Transport.mcp() })

    expect(handler.transport.name).toBe('mcp')
  })
})

describe('request handler', () => {
  test('returns 402 when no Authorization header', async () => {
    const handler = Mpay.create({ methods: [method], realm, secretKey })

    const request = new Request('https://example.com/resource')

    const result = await handler.charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    expect(result.challenge.headers.get('WWW-Authenticate')).toContain('Payment')

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Payment is required for "api.example.com".",
        "instance": "[instance]",
        "status": 402,
        "title": "PaymentRequiredError",
        "type": "https://tempoxyz.github.io/payment-auth-spec/problems/payment-required",
      }
    `)
  })

  test('returns 402 with challenge for malformed credential', async () => {
    const request = new Request('https://example.com/resource', {
      headers: { Authorization: 'Payment invalid' },
    })

    const result = await Mpay.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Credential is malformed: Invalid base64url or JSON..",
        "instance": "[instance]",
        "status": 402,
        "title": "MalformedCredentialError",
        "type": "https://tempoxyz.github.io/payment-auth-spec/problems/malformed-credential",
      }
    `)
  })

  test('returns 402 when challenge ID mismatch', async () => {
    const wrongChallenge = Challenge.from({
      id: 'wrong-id',
      intent: 'charge',
      method: 'tempo',
      realm,
      request: { amount: '1000', currency: asset, recipient: accounts[0].address },
    })
    const credential = Credential.from({
      challenge: wrongChallenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const request = new Request('https://example.com/resource', {
      headers: { Authorization: Credential.serialize(credential) },
    })

    const result = await Mpay.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Challenge "wrong-id" is invalid: challenge was not issued by this server.",
        "instance": "[instance]",
        "status": 402,
        "title": "InvalidChallengeError",
        "type": "https://tempoxyz.github.io/payment-auth-spec/problems/invalid-challenge",
      }
    `)
  })

  test('returns 402 when payload schema validation fails', async () => {
    const handle = Mpay.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)

    const credential = Credential.from({
      challenge,
      payload: { invalidField: 'bad' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { detail: string }
    expect({
      ...body,
      challengeId: '[challengeId]',
      detail: '[detail]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "[detail]",
        "instance": "[instance]",
        "status": 402,
        "title": "InvalidPayloadError",
        "type": "https://tempoxyz.github.io/payment-auth-spec/problems/invalid-payload",
      }
    `)
    expect(body.detail).toContain('Credential payload is invalid')
  })
})

describe('request handler (node)', () => {
  test('returns 402 when no Authorization header', async () => {
    const handler = Mpay.create({ methods: [method], realm, secretKey })

    const server = await Http.createServer(async (req, res) => {
      const result = await Mpay.toNodeListener(
        handler.charge({
          amount: '1000',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    const body = (await response.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Payment is required for "api.example.com".",
        "instance": "[instance]",
        "status": 402,
        "title": "PaymentRequiredError",
        "type": "https://tempoxyz.github.io/payment-auth-spec/problems/payment-required",
      }
    `)

    server.close()
  })

  test('returns 200 with Payment-Receipt header on success', async () => {
    const handler = Mpay.create({ methods: [method], realm, secretKey })
    const expires = new Date(Date.now() + 60_000).toISOString()

    const server = await Http.createServer(async (req, res) => {
      const result = await Mpay.toNodeListener(
        handler.charge({
          amount: '1000',
          currency: asset,
          expires,
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const firstResponse = await fetch(server.url)
    expect(firstResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(firstResponse)

    const credential = Credential.from({
      challenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const response = await fetch(server.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    expect(response.status).toBe(402)

    const body = (await response.json()) as { detail: string }
    expect({
      ...body,
      challengeId: '[challengeId]',
      detail: '[detail]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "[detail]",
        "instance": "[instance]",
        "status": 402,
        "title": "VerificationFailedError",
        "type": "https://tempoxyz.github.io/payment-auth-spec/problems/verification-failed",
      }
    `)
    expect(body.detail).toContain('Payment verification failed')

    server.close()
  })
})

describe('Mpay.tempo', () => {
  test('creates handler with charge and stream methods', () => {
    const handler = Mpay.tempo({
      storage: {
        getChannel: async () => null,
        getSession: async () => null,
        updateChannel: async () => null,
        updateSession: async () => null,
      } as never,
      getClient: () => client,
      realm,
      secretKey,
    })

    expect(handler.realm).toBe(realm)
    expect(typeof handler.charge).toBe('function')
    expect(typeof handler.stream).toBe('function')
  })

  test('returns 402 when no credential', async () => {
    const handler = Mpay.tempo({
      storage: {
        getChannel: async () => null,
        getSession: async () => null,
        updateChannel: async () => null,
        updateSession: async () => null,
      } as never,
      getClient: () => client,
      realm,
      secretKey,
    })

    const result = await handler.charge({
      amount: '1000',
      currency: asset,
      recipient: accounts[0].address,
    })(new Request('https://example.com/resource'))

    expect(result.status).toBe(402)
  })
})

describe('receipt handling', () => {
  test('returns 200 when verify returns a success receipt', async () => {
    const mockCharge = MethodIntent.fromIntent(Intent.charge, {
      method: 'mock',
      schema: {
        credential: {
          payload: z.object({ token: z.string() }),
        },
        request: {
          requires: ['recipient'],
        },
      },
    })

    const mockMethod = MethodIntent.toServer(mockCharge, {
      async verify() {
        return {
          method: 'mock',
          reference: 'tx-success-456',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mpay.create({
      methods: [mockMethod],
      realm,
      secretKey,
    })

    const handle = handler.charge({
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)

    const credential = Credential.from({
      challenge,
      payload: { token: 'valid-token' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })
})
