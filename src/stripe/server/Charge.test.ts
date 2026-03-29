import { Challenge, Credential } from 'mppx'
import { Mppx, stripe } from 'mppx/server'
import { afterEach, describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

import type { StripeClient } from '../internal/types.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

let httpServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => httpServer?.close())

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
      shared_payment_granted_token: 'spt_test_token',
    })
    expect(params.payment_method).toBeUndefined()
    expect(params.automatic_payment_methods).toMatchObject({
      allow_redirects: 'never',
      enabled: true,
    })
    expect(options.idempotencyKey).toMatch(/^mppx_/)
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

    await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    const [params] = create.mock.calls[0]!
    expect(params.metadata).toMatchObject({ plan: 'pro' })
    expect(params.metadata.mpp_is_mpp).toBe('true')
  })

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
