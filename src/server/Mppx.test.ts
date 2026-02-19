import { Challenge, Credential, Method, z } from 'mppx'
import { Mppx, Transport, tempo } from 'mppx/server'
import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const method = tempo({
  getClient: () => client,
})

describe('create', () => {
  test('default', () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    expect(handler.realm).toBe(realm)
    expect(handler.transport.name).toBe('http')
    expect(typeof handler.charge).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey, transport: Transport.mcp() })

    expect(handler.transport.name).toBe('mcp')
  })
})

describe('request handler', () => {
  test('returns 402 when no Authorization header', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

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
        "title": "Payment Required",
        "type": "https://paymentauth.org/problems/payment-required",
      }
    `)
  })

  test('returns 402 with challenge for malformed credential', async () => {
    const request = new Request('https://example.com/resource', {
      headers: { Authorization: 'Payment invalid' },
    })

    const result = await Mppx.create({ methods: [method], realm, secretKey }).charge({
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
        "title": "Malformed Credential",
        "type": "https://paymentauth.org/problems/malformed-credential",
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

    const result = await Mppx.create({ methods: [method], realm, secretKey }).charge({
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
        "title": "Invalid Challenge",
        "type": "https://paymentauth.org/problems/invalid-challenge",
      }
    `)
  })

  test('returns 402 when payload schema validation fails', async () => {
    const handle = Mppx.create({ methods: [method], realm, secretKey }).charge({
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
        "title": "Invalid Payload",
        "type": "https://paymentauth.org/problems/invalid-payload",
      }
    `)
    expect(body.detail).toContain('Credential payload is invalid')
  })
})

describe('request handler (node)', () => {
  test('returns 402 when no Authorization header', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
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
        "title": "Payment Required",
        "type": "https://paymentauth.org/problems/payment-required",
      }
    `)

    server.close()
  })

  test('returns 200 with Payment-Receipt header on success', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })
    const expires = new Date(Date.now() + 60_000).toISOString()

    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
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
        "title": "Verification Failed",
        "type": "https://paymentauth.org/problems/verification-failed",
      }
    `)
    expect(body.detail).toContain('Payment verification failed')

    server.close()
  })
})

describe('receipt handling', () => {
  test('returns 200 when verify returns a success receipt', async () => {
    const mockCharge = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: {
          payload: z.object({ token: z.string() }),
        },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          decimals: z.number(),
          recipient: z.string(),
        }),
      },
    })

    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return {
          method: 'mock',
          reference: 'tx-success-456',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mppx.create({
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

describe('withReceipt', () => {
  const mockCharge = Method.from({
    name: 'mock',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  const mockMethod = Method.toServer(mockCharge, {
    async verify() {
      return {
        method: 'mock',
        reference: 'tx-success-456',
        status: 'success' as const,
        timestamp: new Date().toISOString(),
      }
    },
  })

  test('withReceipt attaches Payment-Receipt header to response', async () => {
    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })

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
    const credential = Credential.from({ challenge, payload: { token: 'valid-token' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt(Response.json({ data: 'ok' }))
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()

    const body = await response.json()
    expect(body).toEqual({ data: 'ok' })
  })

  test('withReceipt throws when called without response arg and no management response', async () => {
    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })

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
    const credential = Credential.from({ challenge, payload: { token: 'valid-token' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    expect(() => result.withReceipt()).toThrow('withReceipt() requires a response argument')
  })

  test('withReceipt returns management response when respond hook returns Response', async () => {
    const mockMethodWithRespond = Method.toServer(mockCharge, {
      async verify() {
        return {
          method: 'mock',
          reference: 'ref',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
      respond() {
        return new Response(null, { status: 204 })
      },
    })

    const handler = Mppx.create({ methods: [mockMethodWithRespond], realm, secretKey })

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
    const credential = Credential.from({ challenge, payload: { token: 'valid-token' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt()
    expect(response.status).toBe(204)
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('toNodeListener sets Payment-Receipt header on 200', async () => {
    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })

    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        handler.charge({
          amount: '1000',
          currency: '0x0000000000000000000000000000000000000001',
          decimals: 6,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: '0x0000000000000000000000000000000000000002',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const firstResponse = await fetch(server.url)
    expect(firstResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(firstResponse)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const response = await fetch(server.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()

    server.close()
  })
})
