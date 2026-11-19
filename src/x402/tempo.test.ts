import { paymentMiddleware } from '@x402/hono'
import { Hono } from 'hono'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import { tempoX402 } from './tempo.js'

const depositAddress = '0x1111111111111111111111111111111111111111'
const payoutAddress = '0x2222222222222222222222222222222222222222'

function stubFacilitator(payTo = { current: depositAddress }) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      calls.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), url })
      if (url.endsWith('/supported'))
        return Response.json({
          extensions: [],
          kinds: [
            {
              extra: { payTo: payTo.current },
              network: 'eip155:8453',
              scheme: 'exact',
              x402Version: 2,
            },
          ],
          signers: {},
        })
      return new Response('not found', { status: 404 })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('tempoX402', () => {
  test('answers a paid route with the deposit address and the payout address', async () => {
    const calls = stubFacilitator()
    const tempo = tempoX402({ apiKey: 'tempo:sk:test', payoutAddress })
    const app = new Hono()
    app.use(paymentMiddleware({ 'GET /weather': tempo.route({ price: '$0.01' }) }, tempo.server))
    app.get('/weather', (c) => c.json({ forecast: 'sunny' }))

    const response = await app.request('/weather')
    expect(response.status).toBe(402)
    const required = JSON.parse(
      Buffer.from(response.headers.get('payment-required')!, 'base64').toString(),
    )
    expect(required.accepts).toHaveLength(1)
    expect(required.accepts[0]).toMatchObject({
      amount: '10000',
      extra: { tempoSettlement: payoutAddress },
      network: 'eip155:8453',
      payTo: depositAddress,
      scheme: 'exact',
    })
    expect(calls.every((call) => call.url.startsWith('https://api.tempo.xyz/v1/x402/'))).toBe(true)
    expect(
      calls.every(
        (call) =>
          call.url.endsWith('/supported') || call.headers['tempo-api-key'] === 'tempo:sk:test',
      ),
    ).toBe(true)
  })

  test('reads TEMPO_API_KEY and TEMPO_PAYOUT_ADDRESS', () => {
    vi.stubEnv('TEMPO_API_KEY', 'tempo:sk:env')
    vi.stubEnv('TEMPO_PAYOUT_ADDRESS', payoutAddress)
    const route = tempoX402().route({ price: '$0.01' })
    expect(route.accepts).toMatchObject({ extra: { tempoSettlement: payoutAddress } })
  })

  test('lets a route pay out to its own address', () => {
    const route = tempoX402({ apiKey: 'k', payoutAddress }).route({
      payoutAddress: depositAddress,
      price: '$0.10',
    })
    expect(route.accepts).toMatchObject({ extra: { tempoSettlement: depositAddress } })
  })

  test('fails a route with no published deposit address instead of quoting none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          extensions: [],
          kinds: [{ network: 'eip155:8453', scheme: 'exact', x402Version: 2 }],
          signers: {},
        }),
      ),
    )
    const tempo = tempoX402({ apiKey: 'k', payoutAddress })
    const app = new Hono()
    app.use(paymentMiddleware({ 'GET /weather': tempo.route({ price: '$0.01' }) }, tempo.server))
    app.get('/weather', (c) => c.json({ forecast: 'sunny' }))
    const response = await app.request('/weather')
    expect(response.status).not.toBe(200)
    expect(response.headers.get('payment-required')).toBeNull()
  })

  test('requires an API key and a payout address', () => {
    vi.stubEnv('TEMPO_API_KEY', '')
    expect(() => tempoX402()).toThrow(/TEMPO_API_KEY/)
    vi.stubEnv('TEMPO_PAYOUT_ADDRESS', '')
    expect(() => tempoX402({ apiKey: 'k' }).route({ price: '$0.01' })).toThrow(/payout address/)
  })
})

describe('tempoX402 payout address', () => {
  test('rejects a malformed payout address', () => {
    expect(() =>
      tempoX402({ apiKey: 'k', payoutAddress: '0x1234' }).route({ price: '$0.01' }),
    ).toThrow(/not an address/)
  })
})
