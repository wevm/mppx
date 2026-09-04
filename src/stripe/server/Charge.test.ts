import { Challenge, Credential, Errors, Receipt } from 'mppx'
import { Mppx, stripe } from 'mppx/server'
import { afterEach, describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

import { sdkIdentifier } from '../../internal/version.js'
import type { StripeClient } from '../internal/types.js'
import type { charge as StripeCharge } from './Charge.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key-test-secret-key-32'

let httpServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => {
  httpServer?.close()
  httpServer = undefined
  vi.restoreAllMocks()
})

function createMockStripeClient(
  overrides?: Partial<{ status: string; id: string; throws: boolean }>,
): { client: StripeClient; create: ReturnType<typeof vi.fn> } {
  const { status = 'succeeded', id = 'pi_mock_123', throws = false } = overrides ?? {}
  let callCount = 0
  const create = vi.fn(async () => {
    if (throws) throw new Error('Stripe API error')
    callCount++
    return {
      id,
      status,
      ...(callCount > 1 ? { lastResponse: { headers: { 'idempotent-replayed': 'true' } } } : {}),
    }
  })
  return {
    client: { paymentIntents: { create } },
    create,
  }
}

describe('stripe.charge offer availability', () => {
  test.each([
    { atMinimum: '0.50', belowMinimum: '0.49', currency: 'usd', decimals: 2, normalized: '50' },
    { atMinimum: '0.30', belowMinimum: '0.29', currency: 'gbp', decimals: 2, normalized: '30' },
    { atMinimum: '50', belowMinimum: '49', currency: 'jpy', decimals: 0, normalized: '50' },
    { atMinimum: '10', belowMinimum: '9.99', currency: 'mxn', decimals: 2, normalized: '1000' },
  ])(
    'filters $currency offers below the Stripe currency minimum',
    async ({ atMinimum, belowMinimum, currency, decimals, normalized }) => {
      const { client } = createMockStripeClient()
      const stripeCharge = stripe.charge({
        client,
        networkId: 'internal',
        paymentMethodTypes: ['card'],
      })
      const server = Mppx.create({ methods: [stripeCharge], realm, secretKey })

      const result = await server.compose(
        [stripeCharge, { amount: belowMinimum, currency, decimals }],
        [stripeCharge, { amount: atMinimum, currency, decimals }],
      )(new Request('https://example.com/resource'))

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()
      const challenges = Challenge.fromResponseList(result.challenge)
      expect(challenges).toHaveLength(1)
      expect(challenges[0]?.request).toMatchObject({ amount: normalized, currency })
    },
  )

  test('composes constructor canOffer after the Stripe currency minimum', async () => {
    const { client } = createMockStripeClient()
    const offeredAmounts: string[] = []
    const stripeCharge = stripe.charge({
      client,
      canOffer({ request }) {
        offeredAmounts.push(request.amount)
        return BigInt(request.amount) >= 100n
      },
      networkId: 'internal',
      paymentMethodTypes: ['card'],
    })
    const server = Mppx.create({ methods: [stripeCharge], realm, secretKey })

    const result = await server.compose(
      [stripeCharge, { amount: '0.49', currency: 'usd', decimals: 2 }],
      [stripeCharge, { amount: '0.50', currency: 'usd', decimals: 2 }],
      [stripeCharge, { amount: '1', currency: 'usd', decimals: 2 }],
    )(new Request('https://example.com/resource'))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(offeredAmounts).toEqual(['50', '100'])
    expect(
      Challenge.fromResponseList(result.challenge).map(({ request }) => request.amount),
    ).toEqual(['100'])
  })

  test('lets constructor canOffer decide availability for an unknown currency', async () => {
    const { client } = createMockStripeClient()
    const canOffer = vi.fn(() => true)
    const stripeCharge = stripe.charge({
      client,
      canOffer,
      networkId: 'internal',
      paymentMethodTypes: ['card'],
    })
    const server = Mppx.create({ methods: [stripeCharge], realm, secretKey })

    const result = await server.compose([
      stripeCharge,
      { amount: '0.01', currency: 'unknown', decimals: 2 },
    ])(new Request('https://example.com/resource'))

    expect(result.status).toBe(402)
    expect(canOffer).toHaveBeenCalledOnce()
  })
})

describe('stripe.charge with client', () => {
  test('default: verifies payment via client.paymentIntents.create', async () => {
    const { client, create } = createMockStripeClient()

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(402)

    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(200)
    expect(create).toHaveBeenCalledOnce()

    const [params, options] = create.mock.calls[0]!
    expect(params).toMatchObject({
      amount: 100,
      confirm: true,
      currency: 'usd',
      metadata: {
        machine_payment: 'true',
        mpp_challenge_id: challenge.id,
        mpp_intent: 'charge',
        mpp_sdk: sdkIdentifier,
      },
      shared_payment_granted_token: 'spt_test_token',
    })
    expect(params.payment_method).toBeUndefined()
    expect(params.automatic_payment_methods).toMatchObject({
      allow_redirects: 'never',
      enabled: true,
    })
    expect(options.idempotencyKey).toBe(`mpp_${challenge.id}_spt_test_token`)
  })

  test('behavior: includes metadata in client call', async () => {
    const { client, create } = createMockStripeClient()

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          metadata: { plan: 'pro' },
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({
          amount: '1',
          currency: 'usd',
          decimals: 2,
          paymentIntentOptions: {
            amount: 999,
            confirm: false,
            customer: 'cus_123',
            currency: 'eur',
            hooks: { inputs: { tax: { calculation: 'taxcalc_123' } } },
            metadata: {
              machine_payment: 'custom',
              mpp_challenge_id: 'custom',
              plan: 'enterprise',
              request_id: 'req_123',
            },
            receipt_email: 'customer@example.com',
          } as any,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    expect(challenge.request).not.toHaveProperty('paymentIntentOptions')
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    const [params] = create.mock.calls[0]!
    expect(params.amount).toBe(100)
    expect(params.confirm).toBe(true)
    expect(params.customer).toBe('cus_123')
    expect(params.currency).toBe('usd')
    expect(params.hooks).toEqual({ inputs: { tax: { calculation: 'taxcalc_123' } } })
    expect(params.metadata).toMatchObject({
      machine_payment: 'custom',
      mpp_challenge_id: 'custom',
      plan: 'enterprise',
      request_id: 'req_123',
    })
    expect(params.metadata).not.toHaveProperty('mpp_is_mpp')
    expect(params.metadata).not.toHaveProperty('mpp_version')
    expect(params.receipt_email).toBe('customer@example.com')
  })

  test('behavior: resolves PaymentIntent options after challenge validation', async () => {
    const { client, create } = createMockStripeClient()
    const calls: string[] = []
    const connect = vi.fn(() => {
      calls.push('connect')
      return { stripeAccount: 'acct_123' }
    })
    const paymentIntentOptions = vi.fn(
      async ({
        challenge,
        credential,
        envelope,
        request,
      }: StripeCharge.ResolvePaymentIntentOptionsContext) => {
        calls.push('resolve')
        expect(credential.challenge).toEqual(challenge)
        expect(envelope?.credential).toEqual(credential)
        expect(request.amount).toBe('100')
        return {
          hooks: { inputs: { tax: { calculation: `taxcalc_${challenge.id}` } } },
          metadata: { order: 'order_123' },
        }
      },
    )
    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          connect,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })
    const handle = server.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      paymentIntentOptions,
    })

    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    expect(paymentIntentOptions).not.toHaveBeenCalled()
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    expect(challenge.request).not.toHaveProperty('paymentIntentOptions')
    const forgedCredential = Credential.from({
      challenge: { ...challenge, id: 'forged' },
      payload: { spt: 'spt_test_token' },
    })
    const rejected = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(forgedCredential) },
      }),
    )
    expect(rejected.status).toBe(402)
    expect(paymentIntentOptions).not.toHaveBeenCalled()

    const credential = Credential.from({ challenge, payload: { spt: 'spt_test_token' } })
    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    expect(calls).toEqual(['connect', 'resolve'])
    expect(paymentIntentOptions).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        hooks: { inputs: { tax: { calculation: `taxcalc_${challenge.id}` } } },
        metadata: expect.objectContaining({ order: 'order_123' }),
      }),
      expect.anything(),
    )
  })

  test('error: returns a resolver BadRequestError without creating a PaymentIntent', async () => {
    const { client, create } = createMockStripeClient()
    const server = Mppx.create({
      methods: [stripe.charge({ client, networkId: 'internal', paymentMethodTypes: ['card'] })],
      realm,
      secretKey,
    })
    const handle = server.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      paymentIntentOptions: async () => {
        throw new Errors.BadRequestError({ reason: 'invalid tax location' })
      },
    })
    const firstResult = await handle(new Request('https://example.com'))
    if (firstResult.status !== 402) throw new Error()
    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { spt: 'spt_test_token' } })

    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.challenge.status).toBe(400)
    await expect(result.challenge.json()).resolves.toMatchObject({
      detail: 'Bad request: invalid tax location.',
      status: 400,
    })
    expect(create).not.toHaveBeenCalled()
  })

  test('behavior: applies Connect settlement parameters in client call', async () => {
    const { client, create } = createMockStripeClient()

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          connect({ request }) {
            expect(request.amount).toBe('100')
            return {
              applicationFeeAmount: 12,
              onBehalfOf: 'acct_merchant',
              stripeAccount: 'acct_connected',
              transferData: { amount: 88, destination: 'acct_destination' },
              transferGroup: 'order_123',
            }
          },
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({ amount: '1', currency: 'usd', decimals: 2 })
    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    expect(challenge.request).not.toHaveProperty('connect')
    expect(challenge.request.methodDetails).not.toHaveProperty('applicationFeeAmount')
    expect(challenge.request.methodDetails).not.toHaveProperty('stripeAccount')

    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    const [params, options] = create.mock.calls[0]!
    expect(params).toMatchObject({
      application_fee_amount: 12,
      on_behalf_of: 'acct_merchant',
      transfer_data: { amount: 88, destination: 'acct_destination' },
      transfer_group: 'order_123',
    })
    expect(options).toMatchObject({ stripeAccount: 'acct_connected' })
  })

  test('behavior: applies Connect settlement parameters in secretKey call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'pi_fetch_123', status: 'succeeded' }), {
        status: 200,
      }),
    )

    const server = Mppx.create({
      methods: [
        stripe.charge({
          connect: {
            applicationFeeAmount: 12,
            onBehalfOf: 'acct_merchant',
            stripeAccount: 'acct_connected',
            transferData: { amount: 88, destination: 'acct_destination' },
            transferGroup: 'order_123',
          },
          networkId: 'internal',
          paymentMethodTypes: ['card'],
          secretKey,
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      paymentIntentOptions: {
        customer: 'cus_123',
        hooks: { inputs: { tax: { calculation: 'taxcalc_123' } } },
        receipt_email: 'customer@example.com',
      },
    })
    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const credential = Credential.from({
      challenge: Challenge.fromResponse(firstResult.challenge),
      payload: { spt: 'spt_test_token' },
    })
    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe('https://api.stripe.com/v1/payment_intents')
    const headers = new Headers(init?.headers)
    expect(headers.get('Idempotency-Key')).toBe(`mpp_${credential.challenge.id}_spt_test_token`)
    expect(headers.get('Stripe-Account')).toBe('acct_connected')
    const body = init?.body as URLSearchParams
    expect(body.get('application_fee_amount')).toBe('12')
    expect(body.get('on_behalf_of')).toBe('acct_merchant')
    expect(body.get('transfer_data[amount]')).toBe('88')
    expect(body.get('transfer_data[destination]')).toBe('acct_destination')
    expect(body.get('transfer_group')).toBe('order_123')
    expect(body.get('customer')).toBe('cus_123')
    expect(body.get('hooks[inputs][tax][calculation]')).toBe('taxcalc_123')
    expect(body.get('receipt_email')).toBe('customer@example.com')
  })

  test('security: attributes receipt externalId from the server-bound request', async () => {
    const { client } = createMockStripeClient()
    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      externalId: 'server-order-123',
    })
    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const credential = Credential.from({
      challenge: Challenge.fromResponse(firstResult.challenge),
      payload: { spt: 'spt_test_token', externalId: 'server-order-123' },
    })
    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()
    const receipt = Receipt.fromResponse(result.withReceipt(new Response('OK')))
    expect(receipt.externalId).toBe('server-order-123')
  })

  test('security: rejects forged Stripe credential externalId', async () => {
    const { client, create } = createMockStripeClient()
    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      externalId: 'server-order-123',
    })
    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const credential = Credential.from({
      challenge: Challenge.fromResponse(firstResult.challenge),
      payload: { spt: 'spt_test_token', externalId: 'attacker-order-999' },
    })
    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    expect(create).not.toHaveBeenCalled()
  })

  test('security: ignores payload-only Stripe credential externalId', async () => {
    const { client } = createMockStripeClient()
    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({ amount: '1', currency: 'usd', decimals: 2 })
    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const credential = Credential.from({
      challenge: Challenge.fromResponse(firstResult.challenge),
      payload: { spt: 'spt_test_token', externalId: 'attacker-order-999' },
    })
    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()
    const receipt = Receipt.fromResponse(result.withReceipt(new Response('OK')))
    expect(receipt.externalId).toBeUndefined()
  })

  test('error: surfaces Connect PaymentIntent creation failures', async () => {
    const { client } = createMockStripeClient({ throws: true })

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          connect: { stripeAccount: 'acct_connected' },
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(402)
    const body = (await paidResponse.json()) as { detail: string }
    expect(body.detail).toContain('Stripe PaymentIntent failed')
  })

  const invalidConnectCases: readonly {
    name: string
    connect: StripeCharge.ConnectSettlement
  }[] = [
    { name: 'empty stripeAccount', connect: { stripeAccount: '' } },
    { name: 'fee exceeds amount', connect: { applicationFeeAmount: 101 } },
    { name: 'negative fee', connect: { applicationFeeAmount: -1 } },
    {
      name: 'empty transfer destination',
      connect: { transferData: { destination: '' } },
    },
    {
      name: 'missing transfer destination',
      connect: { transferData: {} } as StripeCharge.ConnectSettlement,
    },
    {
      name: 'transfer amount exceeds amount',
      connect: { transferData: { amount: 101, destination: 'acct_destination' } },
    },
  ]

  for (const { connect, name } of invalidConnectCases) {
    test(`error: rejects invalid Connect settlement parameters (${name})`, async () => {
      const { client, create } = createMockStripeClient()

      const server = Mppx.create({
        methods: [
          stripe.charge({
            client,
            connect,
            networkId: 'internal',
            paymentMethodTypes: ['card'],
          }),
        ],
        realm,
        secretKey,
      })

      const handle = server.charge({ amount: '1', currency: 'usd', decimals: 2 })
      const firstResult = await handle(new Request('https://example.com'))
      expect(firstResult.status).toBe(402)
      if (firstResult.status !== 402) throw new Error()

      const credential = Credential.from({
        challenge: Challenge.fromResponse(firstResult.challenge),
        payload: { spt: 'spt_test_token' },
      })
      const result = await handle(
        new Request('https://example.com', {
          headers: { Authorization: Credential.serialize(credential) },
        }),
      )

      expect(result.status).toBe(402)
      expect(create).not.toHaveBeenCalled()
    })
  }

  test('behavior: rejects when client throws', async () => {
    const { client } = createMockStripeClient({ throws: true })

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(402)
    const body = (await paidResponse.json()) as { detail: string }
    expect(body.detail).toContain('Stripe PaymentIntent failed')
  })

  test('behavior: rejects requires_action status', async () => {
    const { client } = createMockStripeClient({ status: 'requires_action' })

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(402)
    const body = (await paidResponse.json()) as { detail: string }
    expect(body.detail).toContain('requires action')
  })

  test('behavior: rejects replayed credential', async () => {
    const { client } = createMockStripeClient()

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({ amount: '1', currency: 'usd', decimals: 2 })

    // First request: get challenge
    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    // First payment: should succeed
    const result1 = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result1.status).toBe(200)

    // Replay same credential: should be rejected
    const result2 = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result2.status).toBe(402)
  })

  test('behavior: receipt contains mock reference', async () => {
    const { client } = createMockStripeClient({ id: 'pi_custom_ref' })

    const server = Mppx.create({
      methods: [
        stripe.charge({
          client,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm,
      secretKey,
    })

    const handle = server.charge({ amount: '1', currency: 'usd', decimals: 2 })

    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { spt: 'spt_test_token' },
    })

    const result = await handle(
      new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const wrapped = result.withReceipt(Response.json({ ok: true }))
    const receiptHeader = wrapped.headers.get('Payment-Receipt')
    expect(receiptHeader).toBeTruthy()

    const decoded = JSON.parse(
      Buffer.from(receiptHeader!.replace('Payment ', ''), 'base64url').toString(),
    ) as { reference: string }
    expect(decoded.reference).toBe('pi_custom_ref')
  })
})
