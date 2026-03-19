import { Challenge, Credential } from 'mppx'
import { Mppx, whop } from 'mppx/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Http from '~test/Http.js'
import type { WhopClient } from '../internal/types.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

let httpServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => httpServer?.close())

function createMockWhopClient(
  overrides?: Partial<{ status: string; total: number; id: string; throws: boolean }>,
): { client: WhopClient; retrieve: ReturnType<typeof vi.fn> } {
  const { status = 'paid', total = 5.0, id = 'pay_mock_123', throws = false } = overrides ?? {}
  const retrieve = vi.fn(async () => {
    if (throws) throw new Error('Whop API error')
    return { id, status, total, subtotal: total, currency: 'usd' }
  })
  return {
    client: {
      payments: { retrieve },
      checkoutConfigurations: {
        create: vi.fn(async () => ({
          id: 'ch_mock',
          purchase_url: 'https://whop.com/checkout/test',
        })),
      },
    },
    retrieve,
  }
}

describe('whop.charge with client', () => {
  test('default: verifies payment via client.payments.retrieve', async () => {
    const { client, retrieve } = createMockWhopClient()

    const server = Mppx.create({
      methods: [whop({ client, companyId: 'biz_test', currency: 'usd' })],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({
          amount: 5.0,
          meta: { purchase_url: 'https://whop.com/checkout/test' },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(402)

    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { paymentId: 'pay_test_token' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(200)
    expect(retrieve).toHaveBeenCalledWith('pay_test_token')
  })

  test('behavior: rejects when payment status is not paid', async () => {
    const { client } = createMockWhopClient({ status: 'open' })

    const server = Mppx.create({
      methods: [whop({ client, companyId: 'biz_test', currency: 'usd' })],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({
          amount: 5.0,
          meta: { purchase_url: 'https://whop.com/checkout/test' },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { paymentId: 'pay_pending' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(402)
    const body = (await paidResponse.json()) as { detail: string }
    expect(body.detail).toContain('Whop payment status: open')
  })

  test('behavior: rejects when amount does not match', async () => {
    const { client } = createMockWhopClient({ total: 99.0 })

    const server = Mppx.create({
      methods: [whop({ client, companyId: 'biz_test', currency: 'usd' })],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({
          amount: 5.0,
          meta: { purchase_url: 'https://whop.com/checkout/test' },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { paymentId: 'pay_wrong_amount' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(402)
    const body = (await paidResponse.json()) as { detail: string }
    expect(body.detail).toContain('Payment amount mismatch')
  })

  test('behavior: rejects when client throws', async () => {
    const { client } = createMockWhopClient({ throws: true })

    const server = Mppx.create({
      methods: [whop({ client, companyId: 'biz_test', currency: 'usd' })],
      realm,
      secretKey,
    })

    httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        server.charge({
          amount: 5.0,
          meta: { purchase_url: 'https://whop.com/checkout/test' },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    const challenge = Challenge.fromResponse(response)
    const credential = Credential.from({
      challenge,
      payload: { paymentId: 'pay_failing' },
    })

    const paidResponse = await fetch(httpServer.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(paidResponse.status).toBe(402)
  })

  test('behavior: receipt contains payment reference', async () => {
    const { client } = createMockWhopClient({ id: 'pay_custom_ref' })

    const server = Mppx.create({
      methods: [whop({ client, companyId: 'biz_test', currency: 'usd' })],
      realm,
      secretKey,
    })

    const handle = server.charge({
      amount: 5.0,
      meta: { purchase_url: 'https://whop.com/checkout/test' },
    })

    const firstResult = await handle(new Request('https://example.com'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { paymentId: 'pay_custom_ref' },
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
      Buffer.from(receiptHeader!, 'base64url').toString(),
    ) as { reference: string; method: string }
    expect(decoded.reference).toBe('pay_custom_ref')
    expect(decoded.method).toBe('whop')
  })

  test('behavior: includes externalId in receipt', async () => {
    const { client } = createMockWhopClient()

    const server = Mppx.create({
      methods: [whop({ client, companyId: 'biz_test', currency: 'usd' })],
      realm,
      secretKey,
    })

    const handle = server.charge({
      amount: 5.0,
      meta: { purchase_url: 'https://whop.com/checkout/test' },
    })

    const firstResult = await handle(new Request('https://example.com'))
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { paymentId: 'pay_ext_test', externalId: 'order_xyz' },
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
    const decoded = JSON.parse(
      Buffer.from(receiptHeader!, 'base64url').toString(),
    ) as { externalId: string }
    expect(decoded.externalId).toBe('order_xyz')
  })
})
