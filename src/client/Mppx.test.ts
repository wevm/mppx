import { Challenge, Credential, Errors, Mcp, Method, Receipt } from 'mppx'
import { Mppx, Transport, tempo } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Methods } from 'mppx/tempo'
import { Header as x402_Header, Types as x402_Types, type PaymentRequired } from 'mppx/x402'
import { afterEach, describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as x402_ChallengeBrand from '../x402/internal/ChallengeBrand.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key-test-secret-key-32'

afterEach(() => {
  Mppx.restore()
  vi.useRealTimers()
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
    expect(typeof mppx.preparePayment).toBe('function')
    expect(typeof mppx.rawFetch).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
      transport: Transport.mcp(),
    })

    expect(mppx.transport.name).toBe('mcp')
  })

  test('behavior: passes maxPaymentRetries to fetch wrapper', async () => {
    const testMethod = Method.toClient(
      Method.from({
        name: 'test',
        intent: 'test',
        schema: Methods.charge.schema,
      }),
      {
        async createCredential() {
          return 'credential'
        },
      },
    )
    const challenge = Challenge.from({
      id: 'retry-cap',
      realm,
      method: 'test',
      intent: 'test',
      request: { amount: '1' },
    })
    let callCount = 0
    const fetch = vi.fn(async () => {
      callCount++
      return new Response(null, {
        status: 402,
        headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
      })
    })
    const mppx = Mppx.create({
      fetch: fetch as typeof globalThis.fetch,
      maxPaymentRetries: 1,
      methods: [testMethod],
      polyfill: false,
    })

    const response = await mppx.fetch('https://example.com/api')

    expect(response.status).toBe(402)
    expect(callCount).toBe(2)
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

describe('preparePayment', () => {
  function paymentMethod(name = 'test') {
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const method = Method.toClient(
      Method.from({
        name,
        intent: 'charge',
        schema: Methods.charge.schema,
      }),
      { createCredential },
    )
    return { createCredential, method }
  }

  function paymentChallenge(id: string, name = 'test') {
    return Challenge.from({
      expires: new Date(Date.now() + 60_000).toISOString(),
      id,
      intent: 'charge',
      method: name,
      realm,
      request: { amount: '100', currency: asset },
    })
  }

  function paymentRequiredResponse(...challenges: Challenge.Challenge[]) {
    return new Response(null, {
      headers: { 'WWW-Authenticate': challenges.map(Challenge.serialize).join(', ') },
      status: 402,
    })
  }

  test('behavior: inspects a payment without signing and memoizes credential creation', async () => {
    const { createCredential, method } = paymentMethod()
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const events: string[] = []
    mppx.onChallengeReceived(({ challenge }) => {
      events.push(`challenge:${challenge.id}`)
    })
    mppx.onCredentialCreated(({ challenge }) => {
      events.push(`credential:${challenge.id}`)
    })
    const challenge = paymentChallenge('selected')

    const prepared = await mppx.preparePayment(paymentRequiredResponse(challenge))

    expect(createCredential).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(prepared.challenge).toBe(prepared.challenges[0])
    expect(prepared.challenge).toEqual(challenge)
    expect(prepared.method.name).toBe('test')
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.challenge)).toBe(true)
    expect(Object.isFrozen(prepared.challenges)).toBe(true)

    const [first, second] = await Promise.all([
      prepared.createCredential(),
      prepared.createCredential(),
    ])

    expect(first).toBe(second)
    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['challenge:selected', 'credential:selected'])
  })

  test('behavior: applies request-local challenge policy before preparation', async () => {
    const { createCredential, method } = paymentMethod()
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const first = paymentChallenge('first')
    const selected = paymentChallenge('selected')

    const prepared = await mppx.preparePayment(paymentRequiredResponse(first, selected), {
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.id === 'selected'),
    })

    expect(prepared.challenge.id).toBe('selected')
    expect(prepared.challenges.map(({ id }) => id)).toEqual(['first', 'selected'])
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('behavior: applies method-owned challenge priority by default', async () => {
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const method = Method.toClient(
      Method.from({
        name: 'test',
        intent: 'charge',
        schema: Methods.charge.schema,
      }),
      {
        createCredential,
        getChallengePriority: ({ challenge }) => (challenge.id === 'funded' ? 1 : -1),
      },
    )
    const mppx = Mppx.create({ methods: [method], polyfill: false })

    const prepared = await mppx.preparePayment(
      paymentRequiredResponse(paymentChallenge('unfunded'), paymentChallenge('funded')),
    )

    expect(prepared.challenge.id).toBe('funded')
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('behavior: prepares a payment after the response body is consumed', async () => {
    const { method } = paymentMethod()
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const response = new Response(JSON.stringify({ message: 'Payment required' }), {
      headers: {
        'content-type': 'application/json',
        'WWW-Authenticate': Challenge.serialize(paymentChallenge('consumed')),
      },
      status: 402,
    })
    await response.json()

    const prepared = await mppx.preparePayment(response)

    expect(prepared.challenge.id).toBe('consumed')
    await expect(prepared.createCredential()).resolves.toBeTypeOf('string')
  })

  test('behavior: signs the immutable challenge that was inspected', async () => {
    const { createCredential, method } = paymentMethod()
    const challenge = paymentChallenge('immutable')
    const response = { challenges: [challenge] }
    const transport = Transport.from<{ credential?: string | undefined }, typeof response>({
      getChallenges: ({ challenges }) => challenges,
      isPaymentRequired: ({ challenges }) => challenges.length > 0,
      name: 'custom',
      setCredential: (request, credential) => ({ ...request, credential }),
    })
    const mppx = Mppx.create({ methods: [method], polyfill: false, transport })
    const prepared = await mppx.preparePayment(response)

    const mutableRequest = challenge.request as { amount: string }
    mutableRequest.amount = '999'
    const credential = await prepared.createCredential()

    expect(createCredential.mock.calls[0]?.[0].challenge).toBe(prepared.challenge)
    expect(Credential.deserialize(credential).challenge.request.amount).toBe('100')
  })

  test('behavior: forwards request context for MCP-over-HTTP', async () => {
    const { method } = paymentMethod()
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const challenge = paymentChallenge('mcp-http')
    const request = {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
      headers: { accept: 'application/json, text/event-stream' },
      method: 'POST',
    } satisfies RequestInit
    const response = new Response(
      JSON.stringify({
        error: {
          code: Mcp.paymentRequiredCode,
          data: { challenges: [challenge] },
          message: 'Payment Required',
        },
        id: 1,
        jsonrpc: '2.0',
      }),
      { headers: { 'content-type': 'application/json' } },
    )

    const prepared = await mppx.preparePayment(response, { request })

    expect(prepared.challenge.id).toBe('mcp-http')
    const credential = await prepared.createCredential()
    const authenticated = prepared.setCredential(request, credential)
    const body = JSON.parse(authenticated.body as string)
    expect(body.params._meta[Mcp.credentialMetaKey]).toBeDefined()
  })

  test('behavior: attaches Payment-auth credentials using Authorization', async () => {
    const { method } = paymentMethod()
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const prepared = await mppx.preparePayment(
      paymentRequiredResponse(paymentChallenge('payment-auth')),
    )

    const request = prepared.setCredential({}, 'Payment credential')
    const headers = new Headers(request.headers)

    expect(headers.get('Authorization')).toBe('Payment credential')
    expect(headers.get(x402_Types.paymentSignatureHeader)).toBeNull()
  })

  test('behavior: attaches x402 credentials using PAYMENT-SIGNATURE', async () => {
    const { createCredential, method } = paymentMethod(x402_Types.paymentMethod)
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const paymentRequired = {
      accepts: [
        {
          amount: '100',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          maxTimeoutSeconds: 60,
          network: 'eip155:84532',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          scheme: x402_Types.schemes[0],
        },
      ],
      resource: { url: 'https://api.example.com/x402' },
      x402Version: 2,
    } satisfies PaymentRequired
    const response = new Response(null, {
      headers: { 'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(paymentRequired) },
      status: 402,
    })

    const prepared = await mppx.preparePayment(response)
    const request = prepared.setCredential({}, 'x402-signature')
    const headers = new Headers(request.headers)

    expect(prepared.challenge.method).toBe(x402_Types.paymentMethod)
    expect(x402_ChallengeBrand.is(prepared.challenge)).toBe(true)
    await prepared.createCredential()
    expect(createCredential.mock.calls[0]?.[0].challenge).toBe(prepared.challenge)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get(x402_Types.paymentSignatureHeader)).toBe('x402-signature')
  })

  test('behavior: rechecks expiration before deferred credential creation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { createCredential, method } = paymentMethod()
    const mppx = Mppx.create({ methods: [method], polyfill: false })
    const paymentFailed = vi.fn()
    mppx.onPaymentFailed(paymentFailed)
    const challenge = {
      ...paymentChallenge('expiring'),
      expires: '2026-01-01T00:00:01.000Z',
    }
    const prepared = await mppx.preparePayment(paymentRequiredResponse(challenge))

    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))

    await expect(prepared.createCredential()).rejects.toThrow(Errors.PaymentExpiredError)
    expect(createCredential).not.toHaveBeenCalled()
    expect(paymentFailed).toHaveBeenCalledOnce()
    expect(paymentFailed.mock.calls[0]?.[0].challenge?.id).toBe('expiring')
  })
})

describe('createCredential', () => {
  function sessionChallenge(id: string, sessionProtocol?: string) {
    return {
      expires: new Date(Date.now() + 60_000).toISOString(),
      id,
      intent: 'session',
      method: 'tempo',
      realm,
      request: {
        amount: '100',
        currency: asset,
        unitType: 'request',
        methodDetails: {
          chainId: 1,
          escrowContract: '0x0000000000000000000000000000000000000001',
          ...(sessionProtocol !== undefined ? { sessionProtocol } : {}),
        },
      },
    } as const
  }

  function paymentRequiredResponse(...challenges: Challenge.Challenge[]) {
    return new Response(null, {
      status: 402,
      headers: { 'WWW-Authenticate': challenges.map(Challenge.serialize).join(', ') },
    })
  }

  function taggedSessionMethod(tag: string, canHandleChallenge: Method.CanHandleChallengeFn) {
    return Method.toClient(Methods.session, {
      canHandleChallenge,
      async createCredential({ challenge }) {
        return Credential.serialize({ challenge, payload: { tag } })
      },
    })
  }

  test('behavior: routes duplicate tempo/session client methods by challenge predicate', async () => {
    const primary = taggedSessionMethod(
      'primary',
      ({ challenge }) =>
        (challenge.request.methodDetails as { sessionProtocol?: string } | undefined)
          ?.sessionProtocol === 'primary',
    )
    const fallback = taggedSessionMethod('fallback', ({ challenge }) => {
      const sessionProtocol = (
        challenge.request.methodDetails as { sessionProtocol?: string } | undefined
      )?.sessionProtocol
      return sessionProtocol === undefined || sessionProtocol === 'fallback'
    })
    const mppx = Mppx.create({ polyfill: false, methods: [primary, fallback] })

    const [primaryCredential, fallbackCredential, unmarkedCredential] = await Promise.all([
      mppx.createCredential(paymentRequiredResponse(sessionChallenge('primary', 'primary'))),
      mppx.createCredential(paymentRequiredResponse(sessionChallenge('fallback', 'fallback'))),
      mppx.createCredential(paymentRequiredResponse(sessionChallenge('unmarked'))),
    ])
    expect(Credential.deserialize(primaryCredential).payload).toEqual({ tag: 'primary' })
    expect(Credential.deserialize(fallbackCredential).payload).toEqual({ tag: 'fallback' })
    expect(Credential.deserialize(unmarkedCredential).payload).toEqual({ tag: 'fallback' })
  })

  test('behavior: rejects unknown tempo/session sessionProtocol', async () => {
    const method = taggedSessionMethod(
      'v2',
      ({ challenge }) =>
        (challenge.request.methodDetails as { sessionProtocol?: string } | undefined)
          ?.sessionProtocol === 'v2',
    )
    const mppx = Mppx.create({ polyfill: false, methods: [method] })

    await expect(
      mppx.createCredential(paymentRequiredResponse(sessionChallenge('unknown', 'future'))),
    ).rejects.toThrow('No method found for challenges: tempo.session')
  })

  test('behavior: routes to correct method based on challenge', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
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

  test('behavior: createCredential emits client events and supports runtime handlers', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const method = Method.toClient(Methods.charge, { createCredential })
    const mppx = Mppx.create({
      polyfill: false,
      methods: [method],
    })
    mppx.onCredentialCreated((payload) => {
      events.push(`credential:${payload.credential.startsWith('Payment ')}`)
    })
    const offCredential = mppx.onCredentialCreated(() => {
      events.push('removed')
    })
    const offChallenge = mppx.onChallengeReceived((payload) => {
      events.push(`runtime:${payload.method.intent}`)
      return payload.createCredential()
    })
    mppx.on('*', (event) => {
      events.push(`*:${event.name}`)
    })
    offCredential()

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
      },
    })
    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mppx.createCredential(response)
    offChallenge()

    expect(credential).toMatch(/^Payment /)
    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      'runtime:charge',
      '*:challenge.received',
      'credential:true',
      '*:credential.created',
    ])
  })

  test('behavior: createCredential memoizes event helper calls', async () => {
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const method = Method.toClient(Methods.charge, { createCredential })
    const mppx = Mppx.create({
      polyfill: false,
      methods: [method],
    })
    mppx.on('*', async (event) => {
      if (event.name === 'challenge.received') await event.payload.createCredential()
    })

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
      },
    })
    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    await mppx.createCredential(response)

    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('behavior: createCredential validates event credentials', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })
    mppx.onChallengeReceived(() => 'Payment invalid\r\nX-Injected: true')

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
      },
    })
    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    await expect(mppx.createCredential(response)).rejects.toThrow('illegal newline')
  })

  test('behavior: throws when method not found', async () => {
    const events: string[] = []
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: accounts[1], getClient: () => client })],
    })
    mppx.onPaymentFailed((payload) => {
      events.push(
        `failed:${payload.challenge === undefined}:${payload.challenges?.length}:${payload.error instanceof Error}`,
      )
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
      'No method found for challenges: unknown.charge. Available: tempo.charge, tempo.session',
    )
    expect(events).toEqual(['failed:true:1:true'])
  })

  test('behavior: rejects expired challenges before creating credential', async () => {
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const method = Method.toClient(Methods.charge, { createCredential })
    const mppx = Mppx.create({
      polyfill: false,
      methods: [method],
    })

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() - 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    await expect(mppx.createCredential(response)).rejects.toThrow(Errors.PaymentExpiredError)
    expect(createCredential).not.toHaveBeenCalled()
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

  test('behavior: selects the preferred challenge from a multi-challenge response', async () => {
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
      paymentPreferences: ({ stripe }) => ({
        [stripe.charge]: 0.5,
      }),
    })

    const tempoChallenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
      },
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
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': `${Challenge.serialize(stripeChallenge)}, ${Challenge.serialize(tempoChallenge)}`,
      },
    })

    const credential = await mppx.createCredential(response)
    const parsed = Credential.deserialize(credential)

    expect(parsed.challenge.method).toBe('tempo')
  })

  test('behavior: createCredential accepts a request-local Accept-Payment override', async () => {
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

    const tempoChallenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
      },
    })
    const stripeChallenge = Challenge.from({
      id: 'stripe-challenge-id',
      realm,
      method: 'stripe',
      intent: 'charge',
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '2000',
        currency: '0xabcd',
        recipient: '0xefgh',
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': `${Challenge.serialize(stripeChallenge)}, ${Challenge.serialize(tempoChallenge)}`,
      },
    })

    const credential = await mppx.createCredential(response, undefined, {
      acceptPayment: 'stripe/charge, tempo/charge;q=0.1',
    })
    const parsed = Credential.deserialize(credential)

    expect(parsed.challenge.method).toBe('stripe')
  })

  test('behavior: createCredential accepts request-local challenge ordering', async () => {
    const testMethod = Method.toClient(
      Method.from({
        name: 'test',
        intent: 'test',
        schema: Methods.charge.schema,
      }),
      {
        async createCredential({ challenge }) {
          return Credential.serialize({
            challenge,
            payload: { signature: `0x${challenge.id}`, type: 'transaction' },
          })
        },
      },
    )

    const mppx = Mppx.create({
      polyfill: false,
      methods: [testMethod],
    })

    const first = Challenge.from({
      id: '1111',
      realm,
      method: 'test',
      intent: 'test',
      request: { currency: 'pathusd' },
    })
    const second = Challenge.from({
      id: '2222',
      realm,
      method: 'test',
      intent: 'test',
      request: { currency: 'usdc' },
    })
    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': `${Challenge.serialize(first)}, ${Challenge.serialize(second)}`,
      },
    })

    const credential = await mppx.createCredential(response, undefined, {
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.request.currency === 'usdc'),
    })
    const parsed = Credential.deserialize(credential)

    expect(parsed.challenge.id).toBe('2222')
  })

  test('behavior: passes context to createCredential', async () => {
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ getClient: () => client })],
    })

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
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

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
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

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
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

  test('behavior: mcp transport event responses are not cast to DOM Response', async () => {
    const method = Method.toClient(Methods.charge, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xsignature', type: 'transaction' },
        })
      },
    })
    const mppx = Mppx.create({
      polyfill: false,
      methods: [method],
      transport: Transport.mcp(),
    })

    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        decimals: 6,
        recipient: '0x1234567890123456789012345678901234567890',
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
    const seen: unknown[] = []
    mppx.onChallengeReceived((event) => {
      seen.push(event.response)
    })

    await mppx.createCredential(mcpResponse)

    expect(seen).toEqual([mcpResponse])
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
  secretKey,
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

describe('rawFetch', () => {
  test('default: returns the original fetch when polyfill is enabled', () => {
    const originalFetch = globalThis.fetch

    const mppx = Mppx.create({
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(globalThis.fetch).not.toBe(originalFetch)
    expect(mppx.rawFetch).toBe(originalFetch)
  })

  test('behavior: returns the original fetch when polyfill is disabled', () => {
    const originalFetch = globalThis.fetch

    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(mppx.rawFetch).toBe(originalFetch)
  })

  test('behavior: returns custom fetch when provided', () => {
    const customFetch = async () => new Response('custom')

    const mppx = Mppx.create({
      polyfill: false,
      fetch: customFetch as typeof globalThis.fetch,
      methods: [
        tempo({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    expect(mppx.rawFetch).toBe(customFetch)
  })

  test('behavior: rawFetch does not intercept 402 responses', async () => {
    const mppx = Mppx.create({
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

    const response = await mppx.rawFetch(httpServer.url)
    expect(response.status).toBe(402)

    httpServer.close()
  })
})
