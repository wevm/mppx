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

  test('http() sends each path its own headers, calling headers per request', async () => {
    const { calls, fetch } = recordingFetch()
    let n = 0
    const headers = vi.fn(async () => {
      n++
      return {
        settle: { Authorization: `Bearer settle-${n}` },
        supported: { 'X-Api-Key': `supported-${n}` },
        verify: { Authorization: `Bearer verify-${n}` },
      }
    })
    const facilitator = Facilitator.http('https://facilitator.example', {
      headers,
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)
    await facilitator.settle(paymentPayload, paymentRequirements)
    await facilitator.supported!()

    expect(headers).toHaveBeenCalledTimes(3)
    expect(calls.map((call) => Object.fromEntries(call.headers))).toEqual([
      { authorization: 'Bearer verify-1', 'content-type': 'application/json' },
      { authorization: 'Bearer settle-2', 'content-type': 'application/json' },
      { 'x-api-key': 'supported-3' },
    ])
  })

  test('http() sends no extra headers for a path headers leaves out', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.http('https://facilitator.example', {
      headers: () => ({ settle: { Authorization: 'Bearer key' } }),
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(Object.fromEntries(calls[0]!.headers)).toEqual({ 'content-type': 'application/json' })
  })

  test('http() sends a flat headers record on every path', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.http('https://facilitator.example', {
      headers: { Authorization: 'Bearer key' },
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)
    await facilitator.settle(paymentPayload, paymentRequirements)
    await facilitator.supported!()

    expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer key',
      'Bearer key',
      'Bearer key',
    ])
  })

  test('http() accepts a function returning a flat record', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.http('https://facilitator.example', {
      headers: async () => ({ 'X-Api-Key': 'key' }),
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)
    await facilitator.supported!()

    expect(calls.map((call) => call.headers.get('x-api-key'))).toEqual(['key', 'key'])
  })

  test('http() accepts a per-path object, not a function', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.http('https://facilitator.example', {
      headers: { verify: { Authorization: 'Bearer verify' }, supported: { 'X-Api-Key': 'k' } },
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)
    await facilitator.settle(paymentPayload, paymentRequirements)
    await facilitator.supported!()

    expect(calls.map((call) => Object.fromEntries(call.headers))).toEqual([
      { authorization: 'Bearer verify', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
      { 'x-api-key': 'k' },
    ])
  })

  test('http() treats a record with a non-path key or a string value as flat', async () => {
    const { calls, fetch } = recordingFetch()
    const mixed = Facilitator.http('https://facilitator.example', {
      headers: { verify: 'x', Authorization: 'Bearer key' },
      fetch,
    })
    const named = Facilitator.http('https://facilitator.example', {
      headers: { verify: 'Bearer verify-as-header' },
      fetch,
    })

    await mixed.settle(paymentPayload, paymentRequirements)
    await named.settle(paymentPayload, paymentRequirements)

    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key')
    expect(calls[0]!.headers.get('verify')).toBe('x')
    expect(calls[1]!.headers.get('verify')).toBe('Bearer verify-as-header')
  })

  test('resolve() accepts a { url, headers } config', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.resolve(
      {
        url: 'https://facilitator.example/',
        headers: () => ({ verify: { Authorization: 'Bearer key' } }),
      },
      undefined,
      { fetch },
    )

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(calls[0]!.url).toBe('https://facilitator.example/verify')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key')
  })

  test("resolve() prefers a config's headers over options", async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.resolve(
      {
        url: 'https://facilitator.example',
        headers: () => ({ verify: { Authorization: 'Bearer config' } }),
      },
      undefined,
      { headers: () => ({ verify: { Authorization: 'Bearer options' } }), fetch },
    )

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(calls[0]!.headers.get('authorization')).toBe('Bearer config')
  })

  test('resolve() applies options.headers to a URL', async () => {
    const { calls, fetch } = recordingFetch()
    const facilitator = Facilitator.resolve('https://facilitator.example', undefined, {
      headers: () => ({ verify: { Authorization: 'Bearer options' } }),
      fetch,
    })

    await facilitator.verify(paymentPayload, paymentRequirements)

    expect(calls[0]!.headers.get('authorization')).toBe('Bearer options')
  })

  test('resolve() keeps a client that has a url field', () => {
    const client = { ...facilitatorStub, url: 'https://facilitator.example' }
    expect(Facilitator.resolve(client)).toBe(client)
  })

  test('payTo() sends headers with GET /supported', async () => {
    const { calls, fetch } = recordingFetch()

    expect(
      await Facilitator.payTo('https://facilitator.example', {
        headers: () => ({ supported: { Authorization: 'Bearer key' } }),
        fetch,
        network: 'eip155:8453',
      }),
    ).toBe(paymentRequirements.payTo)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key')
  })

  test('payTo() accepts a { url, headers } config', async () => {
    const { calls, fetch } = recordingFetch()

    await Facilitator.payTo(
      {
        url: 'https://facilitator.example',
        headers: () => ({ supported: { Authorization: 'Bearer key' } }),
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

describe('x402 facilitator payToResolver', () => {
  const kinds = (payTo: string) => ({
    extensions: [],
    kinds: [{ extra: { payTo }, network: 'eip155:8453', scheme: 'exact', x402Version: 2 }],
    signers: {},
  })

  test('caches payTo for ttl, then refreshes it', async () => {
    vi.useFakeTimers()
    try {
      let current = '0x1111111111111111111111111111111111111111'
      const supported = vi.fn(async () => kinds(current))
      const resolve = Facilitator.payToResolver(
        { ...facilitatorStub, supported } as Types.Facilitator,
        { network: 'eip155:8453', ttl: 1_000 },
      )
      const [a, b] = await Promise.all([resolve(), resolve()])
      expect(a).toBe(current)
      expect(b).toBe(current)
      expect(supported).toHaveBeenCalledTimes(1)

      current = '0x2222222222222222222222222222222222222222'
      expect(await resolve()).toBe('0x1111111111111111111111111111111111111111')
      vi.advanceTimersByTime(1_001)
      expect(await resolve()).toBe(current)
      expect(supported).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps the last payTo when a refresh fails, but throws on the first read', async () => {
    vi.useFakeTimers()
    try {
      const supported = vi
        .fn<() => Promise<ReturnType<typeof kinds>>>()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(kinds('0x1111111111111111111111111111111111111111'))
        .mockRejectedValue(new Error('down'))
      const resolve = Facilitator.payToResolver(
        { ...facilitatorStub, supported } as Types.Facilitator,
        { network: 'eip155:8453', ttl: 1_000 },
      )
      await expect(resolve()).rejects.toThrow('down')
      // A first-read failure is shared until the retry, instead of every caller reading again.
      await expect(resolve()).rejects.toThrow('down')
      expect(supported).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1_001)
      expect(await resolve()).toBe('0x1111111111111111111111111111111111111111')
      vi.advanceTimersByTime(1_001)
      expect(await resolve()).toBe('0x1111111111111111111111111111111111111111')
    } finally {
      vi.useRealTimers()
    }
  })

  test('fails a stalled read after timeout and keeps serving the last address', async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const resolve = Facilitator.createPayToResolver(
        () => {
          reads++
          return reads === 1
            ? Promise.resolve('0x1111111111111111111111111111111111111111')
            : new Promise<string>(() => {})
        },
        { timeout: 500, ttl: 1_000 },
      )
      expect(await resolve()).toBe('0x1111111111111111111111111111111111111111')
      vi.advanceTimersByTime(1_001)
      const stalled = resolve()
      await vi.advanceTimersByTimeAsync(501)
      expect(await stalled).toBe('0x1111111111111111111111111111111111111111')
    } finally {
      vi.useRealTimers()
    }
  })

  test('issued() covers the current address and replaced ones within grace only', async () => {
    vi.useFakeTimers()
    try {
      let next = '0x1111111111111111111111111111111111111111'
      const resolve = Facilitator.createPayToResolver(async () => next, { grace: 1_000, ttl: 0 })
      await resolve()
      next = '0x2222222222222222222222222222222222222222'
      await resolve()
      expect(resolve.current).toBe(next)
      expect(resolve.issued('0x1111111111111111111111111111111111111111')).toBe(
        '0x1111111111111111111111111111111111111111',
      )
      expect(resolve.issued('0x3333333333333333333333333333333333333333')).toBeUndefined()
      vi.advanceTimersByTime(1_001)
      expect(resolve.issued('0x1111111111111111111111111111111111111111')).toBeUndefined()
      expect(resolve.issued(next.toLowerCase())).toBe(next)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('x402 facilitator payToResolver hardening', () => {
  const a = '0x1111111111111111111111111111111111111111'

  test('stops serving the last address after ttl + grace without a successful read', async () => {
    vi.useFakeTimers()
    try {
      let up = true
      const resolve = Facilitator.createPayToResolver(
        async () => {
          if (!up) throw new Error('down')
          return a
        },
        { grace: 1_000, ttl: 1_000 },
      )
      expect(await resolve()).toBe(a)
      up = false
      vi.advanceTimersByTime(1_001)
      expect(await resolve()).toBe(a)
      vi.advanceTimersByTime(1_001)
      await expect(resolve()).rejects.toThrow('down')
    } finally {
      vi.useRealTimers()
    }
  })

  test('measures the cache window from when a slow read finishes', async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const resolve = Facilitator.createPayToResolver(
        () =>
          new Promise<string>((done) => {
            reads++
            setTimeout(() => done(a), 900)
          }),
        { timeout: 5_000, ttl: 1_000 },
      )
      const first = resolve()
      await vi.advanceTimersByTimeAsync(900)
      expect(await first).toBe(a)
      vi.advanceTimersByTime(500)
      expect(await resolve()).toBe(a)
      expect(reads).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('gives each caller its own error for a shared failure', async () => {
    const resolve = Facilitator.createPayToResolver(async () => {
      throw new Error('down')
    })
    const first = await resolve().catch((error) => error)
    const second = await resolve().catch((error) => error)
    const third = await resolve().catch((error) => error)
    expect(second).not.toBe(third)
    expect(String(second.message)).toMatch(/down/)
    expect(first).toBeInstanceOf(Error)
  })

  test('aborts a read that times out', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const resolve = Facilitator.createPayToResolver(
        (options) => {
          signal = options.signal
          return new Promise<string>(() => {})
        },
        { timeout: 500 },
      )
      const pending = resolve().catch((error) => error)
      await vi.advanceTimersByTimeAsync(501)
      expect(await pending).toBeInstanceOf(Error)
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('reads from a facilitator URL refuse redirects and carry the abort signal', async () => {
    const seen: RequestInit[] = []
    const resolve = Facilitator.payToResolver('https://facilitator.example', {
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init ?? {})
        return Response.json({
          extensions: [],
          kinds: [{ extra: { payTo: a }, network: 'eip155:8453', scheme: 'exact', x402Version: 2 }],
          signers: {},
        })
      }) as typeof fetch,
      headers: { 'tempo-api-key': 'k' },
      network: 'eip155:8453',
    })
    expect(await resolve()).toBe(a)
    expect(seen[0]?.redirect).toBe('error')
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
  })
})
