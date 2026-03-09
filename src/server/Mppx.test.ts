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
        "detail": "Payment is required.",
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

  test('returns 402 when credential is from a different route (cross-route scope confusion)', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    // Get a challenge from the "cheap" route
    const cheapHandle = handler.charge({
      amount: '1',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)

    // Build a credential from the cheap challenge
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    // Present it at the "expensive" route
    const expensiveHandle = handler.charge({
      amount: '1000000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toContain('does not match')
  })

  test('returns 402 when credential challenge is expired', async () => {
    const pastExpires = new Date(Date.now() - 60_000).toISOString()

    const handle = Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: pastExpires,
      recipient: accounts[0].address,
    })

    // Get a fresh challenge (which has the expired timestamp baked in)
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)

    const credential = Credential.from({
      challenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as object
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
        "title": "Payment Expired",
        "type": "https://paymentauth.org/problems/payment-expired",
      }
    `)
    expect((body as { detail: string }).detail).toContain('Payment expired at')
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
        "detail": "Payment is required.",
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

describe('offer', () => {
  const mockChargeA = Method.from({
    name: 'alpha',
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

  const mockChargeB = Method.from({
    name: 'beta',
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

  function mockReceipt(name: string) {
    return {
      method: name,
      reference: `tx-${name}`,
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  const alphaMethod = Method.toServer(mockChargeA, {
    async verify() {
      return mockReceipt('alpha')
    },
  })

  const betaMethod = Method.toServer(mockChargeB, {
    async verify() {
      return mockReceipt('beta')
    },
  })

  const offerOpts = {
    amount: '1000',
    currency: '0x0000000000000000000000000000000000000001',
    decimals: 6,
    expires: new Date(Date.now() + 60_000).toISOString(),
    recipient: '0x0000000000000000000000000000000000000002',
  }

  test('returns 402 with multiple WWW-Authenticate headers when no credential', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const result = await mppx.challenge(
      [alphaMethod, offerOpts],
      [betaMethod, offerOpts],
    )(new Request('https://example.com/resource'))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const wwwAuth = result.challenge.headers.get('WWW-Authenticate')!
    expect(wwwAuth).toContain('method="alpha"')
    expect(wwwAuth).toContain('method="beta"')
  })

  test('dispatches to matching handler when credential matches alpha', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.challenge([alphaMethod, offerOpts], [betaMethod, offerOpts])

    // Get challenges
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    // Parse the alpha challenge from the response
    const wwwAuth = firstResult.challenge.headers.get('WWW-Authenticate')!
    const alphaChallenge = Challenge.deserialize(
      wwwAuth.split(', Payment ').map((s, i) => (i === 0 ? s : `Payment ${s}`))[0]!,
    )

    const credential = Credential.from({
      challenge: alphaChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  test('dispatches to matching handler when credential matches beta', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.challenge([alphaMethod, offerOpts], [betaMethod, offerOpts])

    // Get challenges
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    // Parse the beta challenge from the merged header
    const wwwAuth = firstResult.challenge.headers.get('WWW-Authenticate')!
    const parts = wwwAuth.split(', Payment ').map((s, i) => (i === 0 ? s : `Payment ${s}`))
    const betaChallenge = Challenge.deserialize(parts[1]!)

    const credential = Credential.from({
      challenge: betaChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  test('returns 402 when credential method does not match any handler', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.challenge([alphaMethod, offerOpts])

    const wrongChallenge = Challenge.from({
      id: 'wrong-id',
      intent: 'charge',
      method: 'unknown',
      realm,
      request: { amount: '1000', currency: '0x01', recipient: '0x02' },
    })
    const credential = Credential.from({
      challenge: wrongChallenge,
      payload: { token: 'test' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
  })

  test('cross-route protection works through offer()', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    // Get a challenge from a cheap route
    const cheapHandle = mppx.challenge([alphaMethod, { ...offerOpts, amount: '1' }])
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { token: 'valid' },
    })

    // Present it at an expensive route
    const expensiveHandle = mppx.challenge([alphaMethod, { ...offerOpts, amount: '1000000' }])
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toContain('does not match')
  })

  test('withReceipt works through offer()', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.challenge([alphaMethod, offerOpts])

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt(Response.json({ data: 'ok' }))
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('throws when called with no entries', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    expect(() => mppx.challenge()).toThrow('offer() requires at least one entry')
  })

  test('throws when method is not in the methods array', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    expect(() => mppx.challenge([betaMethod, offerOpts] as never)).toThrow(
      'No handler for "beta/charge"',
    )
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

  function mockReceipt() {
    return {
      method: 'mock',
      reference: 'tx-ref',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  test('attaches Payment-Receipt header to response', async () => {
    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
    })

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
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

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

  test('throws when called without response arg and no management response', async () => {
    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })
    const handle = handler.charge({
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    expect(() => result.withReceipt()).toThrow('withReceipt() requires a response argument')
  })

  test('returns management response when respond hook returns Response', async () => {
    const mockMethodWithRespond = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
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
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

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
    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
    })

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
