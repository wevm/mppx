import { Challenge, Credential, Method, z } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

function successReceipt(method = 'mock') {
  return {
    method,
    reference: 'ref-1',
    status: 'success',
    timestamp: '2025-01-01T00:00:00.000Z',
  } as const
}

describe('authorize hook', () => {
  test('grants access without a Payment credential', async () => {
    const method = Method.toServer(
      Method.from({
        name: 'mock',
        intent: 'subscription',
        schema: {
          credential: { payload: z.object({ token: z.string() }) },
          request: z.object({ amount: z.string() }),
        },
      }),
      {
        async authorize() {
          return { receipt: successReceipt() }
        },
        async verify() {
          return successReceipt()
        },
      },
    )

    const handler = Mppx.create({ methods: [method], realm, secretKey })
    const result = await handler['mock/subscription']({ amount: '1' })(
      new Request('https://example.com/resource'),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error('expected authorize success')

    const response = result.withReceipt(new Response('OK'))
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('toNodeListener forwards authorize management responses', async () => {
    const method = Method.toServer(
      Method.from({
        name: 'mock',
        intent: 'subscription',
        schema: {
          credential: { payload: z.object({ token: z.string() }) },
          request: z.object({ amount: z.string() }),
        },
      }),
      {
        async authorize() {
          return {
            receipt: successReceipt(),
            response: new Response('retry later', {
              headers: { 'Retry-After': '1' },
              status: 409,
            }),
          }
        },
        async verify() {
          return successReceipt()
        },
      },
    )

    const handler = Mppx.create({ methods: [method], realm, secretKey })
    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(handler['mock/subscription']({ amount: '1' }))(
        req,
        res,
      )
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(409)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
    expect(await response.text()).toBe('retry later')

    server.close()
  })

  test('compose evaluates authorize hooks sequentially on no-credential requests', async () => {
    const calls: string[] = []
    const createMethod = (
      name: 'alpha' | 'beta',
      authorizeResult?: ReturnType<typeof successReceipt>,
    ) =>
      Method.toServer(
        Method.from({
          name,
          intent: 'charge',
          schema: {
            credential: { payload: z.object({ token: z.string() }) },
            request: z.object({ amount: z.string() }),
          },
        }),
        {
          async authorize() {
            calls.push(`${name}:start`)
            await new Promise((resolve) => setTimeout(resolve, 0))
            calls.push(`${name}:end`)
            return authorizeResult ? { receipt: authorizeResult } : undefined
          },
          async verify() {
            return successReceipt(name)
          },
        },
      )

    const alpha = createMethod('alpha')
    const beta = createMethod('beta', successReceipt('beta'))
    const handler = Mppx.create({ methods: [alpha, beta], realm, secretKey })

    const result = await handler.compose(
      [alpha, { amount: '1' }],
      [beta, { amount: '1' }],
    )(new Request('https://example.com/resource'))

    expect(result.status).toBe(200)
    expect(calls).toEqual(['alpha:start', 'alpha:end', 'beta:start', 'beta:end'])
  })

  test('stableBinding can reject mismatched subscription routes', async () => {
    const method = Method.toServer(
      Method.from({
        name: 'mock',
        intent: 'subscription',
        schema: {
          credential: { payload: z.object({ token: z.string() }) },
          request: z.object({
            amount: z.string(),
            chainId: z.optional(z.number()),
            currency: z.string(),
            periodCount: z.string(),
            periodUnit: z.enum(['day', 'week']),
            recipient: z.string(),
            subscriptionExpires: z.string(),
          }),
        },
      }),
      {
        stableBinding(request) {
          return {
            amount: request.amount,
            chainId: request.chainId,
            currency: request.currency,
            periodCount: request.periodCount,
            periodUnit: request.periodUnit,
            recipient: request.recipient,
            subscriptionExpires: request.subscriptionExpires,
          }
        },
        async verify() {
          return successReceipt()
        },
      },
    )

    const handler = Mppx.create({ methods: [method], realm, secretKey })
    const first = await handler['mock/subscription']({
      amount: '1',
      currency: 'usd',
      periodCount: '30',
      periodUnit: 'day',
      recipient: 'alice',
      subscriptionExpires: '2026-01-01T00:00:00Z',
    })(new Request('https://example.com/cheap'))

    expect(first.status).toBe(402)
    if (first.status !== 402) throw new Error('expected challenge')

    const credential = Credential.from({
      challenge: Challenge.fromResponse(first.challenge),
      payload: { token: 'ok' },
    })

    const second = await handler['mock/subscription']({
      amount: '1',
      currency: 'usd',
      periodCount: '60',
      periodUnit: 'day',
      recipient: 'alice',
      subscriptionExpires: '2026-01-01T00:00:00Z',
    })(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(second.status).toBe(402)
    if (second.status !== 402) throw new Error('expected mismatch challenge')

    const body = (await second.challenge.json()) as { detail: string }
    expect(body.detail).toContain('periodCount')
  })
})
