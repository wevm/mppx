import { afterEach, describe, expect, test, vi } from 'vp/test'

import type * as Types from '../Types.js'
import * as Facilitator from './Facilitator.js'

const paymentRequirements = {
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  extra: {
    assetTransferMethod: 'eip3009',
    name: 'USDC',
    version: '2',
  },
  maxTimeoutSeconds: 60,
  network: 'eip155:84532',
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  scheme: 'exact',
} satisfies Types.PaymentRequirements

const paymentPayload = {
  accepted: paymentRequirements,
  payload: {
    authorization: {
      from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
      nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
      to: paymentRequirements.payTo,
      validAfter: '1740672089',
      validBefore: '1740672154',
      value: paymentRequirements.amount,
    },
    signature:
      '0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c',
  },
  x402Version: 2,
} satisfies Types.PaymentPayload

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('x402 facilitator http client', () => {
  test('sends v2 verify envelopes', async () => {
    const calls: { init?: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input })
      return new Response(JSON.stringify({ isValid: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const facilitator = Facilitator.http('https://facilitator.example')
    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(fetchMock).toHaveBeenCalledOnce()
    const { init } = calls[0]!
    expect(JSON.parse(init!.body as string)).toEqual({
      paymentPayload,
      paymentRequirements,
      x402Version: 2,
    })
  })

  test('sends v2 settle envelopes', async () => {
    const calls: { init?: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input })
      return new Response(
        JSON.stringify({
          network: paymentRequirements.network,
          success: true,
          transaction: `0x${'1'.repeat(64)}`,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const facilitator = Facilitator.http('https://facilitator.example/')
    await facilitator.settle(paymentPayload, paymentRequirements)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(calls[0]!.input).toBe('https://facilitator.example/settle')
    const { init } = calls[0]!
    expect(JSON.parse(init!.body as string)).toEqual({
      paymentPayload,
      paymentRequirements,
      x402Version: 2,
    })
  })

  test('unwraps mppx fetch wrappers', async () => {
    const rawFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ isValid: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const wrappedFetch = vi.fn(async () => {
      throw new Error('wrapped fetch should not be called')
    }) as unknown as typeof globalThis.fetch & {
      [key: symbol]: typeof globalThis.fetch
    }
    wrappedFetch[Symbol.for('mppx.fetch.wrapper')] = rawFetch as typeof globalThis.fetch

    const facilitator = Facilitator.http('https://facilitator.example', { fetch: wrappedFetch })
    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(wrappedFetch).not.toHaveBeenCalled()
    expect(rawFetch).toHaveBeenCalledOnce()
  })
})
