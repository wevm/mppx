import { afterEach, describe, expect, test, vi } from 'vp/test'

import { FacilitatorResponseError } from '../../Errors.js'
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

  test('returns settle extensions shaped by the facilitator', async () => {
    const extensions = { tempoSettlement: { payoutId: 'payout_1', status: 'submitted' } }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              extensions,
              network: paymentRequirements.network,
              success: true,
              transaction: '0x' + '1'.repeat(64),
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    const facilitator = Facilitator.http('https://facilitator.example')
    const settled = await facilitator.settle(paymentPayload, paymentRequirements)
    expect(settled.extensions).toEqual(extensions)
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

describe('x402 facilitator supported and payTo', () => {
  test('http() reads GET /supported', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'eip155:8453',
            extra: { payTo: paymentRequirements.payTo },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const supported = await Facilitator.http('https://facilitator.example/').supported!()
    expect(fetchMock).toHaveBeenCalledWith('https://facilitator.example/supported', {
      method: 'GET',
    })
    expect(supported.kinds[0]!.extra?.payTo).toBe(paymentRequirements.payTo)
  })

  test('payTo() picks the v2 kind for the scheme and network', async () => {
    const supported = vi.fn(async () => ({
      kinds: [
        {
          x402Version: 1,
          scheme: 'exact',
          network: 'eip155:8453',
          extra: { payTo: '0x1111111111111111111111111111111111111111' },
        },
        {
          x402Version: 2,
          scheme: 'upto',
          network: 'eip155:8453',
          extra: { payTo: '0x2222222222222222222222222222222222222222' },
        },
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'eip155:8453',
          extra: { payTo: paymentRequirements.payTo.toLowerCase() },
        },
      ],
    }))
    const facilitator = { ...facilitatorStub, supported }
    expect(await Facilitator.payTo(facilitator, { network: 'eip155:8453' })).toBe(
      paymentRequirements.payTo,
    )
    expect(await Facilitator.payTo(facilitator, { network: 'eip155:8453', scheme: 'upto' })).toBe(
      '0x2222222222222222222222222222222222222222',
    )
  })

  test('payTo() accepts a facilitator URL', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'eip155:8453',
            extra: { payTo: paymentRequirements.payTo },
          },
        ],
      }),
    )
    expect(
      await Facilitator.payTo('https://facilitator.example', {
        fetch: fetchMock as never,
        network: 'eip155:8453',
      }),
    ).toBe(paymentRequirements.payTo)
    expect(fetchMock).toHaveBeenCalledWith('https://facilitator.example/supported', {
      method: 'GET',
    })
  })

  test('payTo() needs supported()', async () => {
    await expect(Facilitator.payTo(facilitatorStub, { network: 'eip155:8453' })).rejects.toThrow(
      /does not implement/,
    )
  })

  test('payTo() fails on a missing kind or bad address', async () => {
    const supported = async () => ({
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: { payTo: 'nope' } },
      ],
    })
    await expect(
      Facilitator.payTo({ ...facilitatorStub, supported }, { network: 'eip155:8453' }),
    ).rejects.toThrow(/publishes no payTo/)
    await expect(
      Facilitator.payTo({ ...facilitatorStub, supported }, { network: 'eip155:1' }),
    ).rejects.toThrow(/publishes no payTo/)
  })
})

describe('x402 facilitator auth headers', () => {
  const supportedBody = {
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        extra: { payTo: paymentRequirements.payTo },
      },
    ],
  }

  function recordingFetch() {
    const calls: { headers: Headers; url: string }[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ headers: new Headers(init?.headers), url })
      if (url.endsWith('/supported')) return Response.json(supportedBody)
      if (url.endsWith('/verify')) return Response.json({ isValid: true })
      return Response.json({
        network: paymentRequirements.network,
        success: true,
        transaction: `0x${'1'.repeat(64)}`,
      })
    })
    return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
  }

  test('http() sends each path its own headers, calling createAuthHeaders per request', async () => {
    const { calls, fetch } = recordingFetch()
    let n = 0
    const createAuthHeaders = vi.fn(async () => {
      n++
      return {
        settle: { Authorization: `Bearer settle-${n}` },
        supported: { 'X-Api-Key': `supported-${n}` },
        verify: { Authorization: `Bearer verify-${n}` },
      }
    })
    const facilitator = Facilitator.http('https://facilitator.example', {
      createAuthHeaders,
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)
    await facilitator.settle(paymentPayload, paymentRequirements)
    await facilitator.supported!()

    expect(createAuthHeaders).toHaveBeenCalledTimes(3)
    expect(calls.map((call) => Object.fromEntries(call.headers))).toEqual([
      { authorization: 'Bearer verify-1', 'content-type': 'application/json' },
      { authorization: 'Bearer settle-2', 'content-type': 'application/json' },
      { 'x-api-key': 'supported-3' },
    ])
  })

  test('http() sends no extra headers for a path createAuthHeaders leaves out', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.http('https://facilitator.example', {
      createAuthHeaders: () => ({ settle: { Authorization: 'Bearer key' } }),
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(Object.fromEntries(calls[0]!.headers)).toEqual({ 'content-type': 'application/json' })
  })

  test('resolve() accepts a { url, createAuthHeaders } config', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.resolve(
      {
        url: 'https://facilitator.example/',
        createAuthHeaders: () => ({ verify: { Authorization: 'Bearer key' } }),
      },
      undefined,
      { fetch },
    )

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(calls[0]!.url).toBe('https://facilitator.example/verify')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key')
  })

  test("resolve() prefers a config's createAuthHeaders over options", async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.resolve(
      {
        url: 'https://facilitator.example',
        createAuthHeaders: () => ({ verify: { Authorization: 'Bearer config' } }),
      },
      undefined,
      { createAuthHeaders: () => ({ verify: { Authorization: 'Bearer options' } }), fetch },
    )

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(calls[0]!.headers.get('authorization')).toBe('Bearer config')
  })

  test('resolve() applies options.createAuthHeaders to a URL', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.resolve('https://facilitator.example', undefined, {
      createAuthHeaders: () => ({ verify: { Authorization: 'Bearer options' } }),
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(calls[0]!.headers.get('authorization')).toBe('Bearer options')
  })

  test('resolve() keeps a client that has a url field', () => {
    const client = { ...facilitatorStub, url: 'https://facilitator.example' }
    expect(Facilitator.resolve(client)).toBe(client)
  })

  test('payTo() sends createAuthHeaders with GET /supported', async () => {
    const { calls, fetch } = recordingFetch()

    expect(
      await Facilitator.payTo('https://facilitator.example', {
        createAuthHeaders: () => ({ supported: { Authorization: 'Bearer key' } }),
        fetch,
        network: 'eip155:8453',
      }),
    ).toBe(paymentRequirements.payTo)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key')
  })

  test('payTo() accepts a { url, createAuthHeaders } config', async () => {
    const { calls, fetch } = recordingFetch()

    await Facilitator.payTo(
      {
        url: 'https://facilitator.example',
        createAuthHeaders: () => ({ supported: { Authorization: 'Bearer key' } }),
      },
      { fetch, network: 'eip155:8453' },
    )
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key')
  })
})

describe('x402 facilitator error responses', () => {
  const unauthorized = () =>
    vi.fn(async () =>
      Response.json({ error: 'missing or invalid API key' }, { status: 401 }),
    ) as unknown as typeof globalThis.fetch

  test('verify() throws FacilitatorResponseError on a 401', async () => {
    const facilitator = Facilitator.http('https://facilitator.example', { fetch: unauthorized() })

    const error = await facilitator.verify(paymentPayload, paymentRequirements).catch((e) => e)

    expect(error).toBeInstanceOf(FacilitatorResponseError)
    expect(error).toMatchObject({
      body: '{"error":"missing or invalid API key"}',
      path: 'verify',
      status: 401,
    })
    expect(error.message).toBe(
      'x402 facilitator /verify failed (401): {"error":"missing or invalid API key"}',
    )
  })

  test('settle() throws FacilitatorResponseError on a 503 with a text body', async () => {
    const fetch = vi.fn(
      async () => new Response('upstream unavailable', { status: 503 }),
    ) as unknown as typeof globalThis.fetch
    const facilitator = Facilitator.http('https://facilitator.example', { fetch })

    await expect(facilitator.settle(paymentPayload, paymentRequirements)).rejects.toMatchObject({
      name: 'FacilitatorResponseError',
      body: 'upstream unavailable',
      path: 'settle',
      status: 503,
    })
  })

  test('supported() throws FacilitatorResponseError on a non-2xx', async () => {
    const facilitator = Facilitator.http('https://facilitator.example', { fetch: unauthorized() })

    await expect(facilitator.supported!()).rejects.toMatchObject({
      path: 'supported',
      status: 401,
    })
  })

  test('truncates long bodies to 200 characters', async () => {
    const fetch = vi.fn(
      async () => new Response('x'.repeat(1000), { status: 500 }),
    ) as unknown as typeof globalThis.fetch
    const facilitator = Facilitator.http('https://facilitator.example', { fetch })

    const error = await facilitator.verify(paymentPayload, paymentRequirements).catch((e) => e)

    expect(error.body).toBe(`${'x'.repeat(197)}...`)
  })

  test('reads a 400 with a failed verify result as that result', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ invalidReason: 'insufficient_funds', isValid: false }, { status: 400 }),
    ) as unknown as typeof globalThis.fetch
    const facilitator = Facilitator.http('https://facilitator.example', { fetch })

    expect(await facilitator.verify(paymentPayload, paymentRequirements)).toEqual({
      invalidReason: 'insufficient_funds',
      isValid: false,
    })
  })

  test('reads a 400 with a failed settle result as that result', async () => {
    const body = {
      errorReason: 'invalid_signature',
      network: paymentRequirements.network,
      success: false,
      transaction: '',
    }
    const fetch = vi.fn(async () =>
      Response.json(body, { status: 400 }),
    ) as unknown as typeof globalThis.fetch
    const facilitator = Facilitator.http('https://facilitator.example', { fetch })

    expect(await facilitator.settle(paymentPayload, paymentRequirements)).toMatchObject({
      errorReason: 'invalid_signature',
      success: false,
    })
  })

  test('throws FacilitatorResponseError on a 2xx that is not a result', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ hello: 'world' }),
    ) as unknown as typeof globalThis.fetch
    const facilitator = Facilitator.http('https://facilitator.example', { fetch })

    const error = await facilitator.verify(paymentPayload, paymentRequirements).catch((e) => e)

    expect(error).toBeInstanceOf(FacilitatorResponseError)
    expect(error).toMatchObject({ path: 'verify', status: 200 })
    expect(error.cause).toBeDefined()
  })
})

const facilitatorStub: Types.Facilitator = {
  async settle() {
    throw new Error('unused')
  },
  async verify() {
    throw new Error('unused')
  },
}
