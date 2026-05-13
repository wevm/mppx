import { Challenge, Errors, Receipt } from 'mppx'
import { tempo } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { createClient, defineChain } from 'viem'
import { describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { accounts, asset, chain, client, http } from '~test/tempo/viem.js'

import * as Fetch from './Fetch.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mppx_server.create({
  methods: [
    tempo_server({
      getClient: () => client,
      account: accounts[0],
    }),
  ],
  realm,
  secretKey,
})

describe('Fetch.from', () => {
  test('default: account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect({
      ...receipt,
      reference: '[reference]',
      timestamp: '[timestamp]',
    }).toMatchInlineSnapshot(`
      {
        "method": "tempo",
        "reference": "[reference]",
        "status": "success",
        "timestamp": "[timestamp]",
      }
    `)

    httpServer.close()
  })

  test('default: account via context', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')

    httpServer.close()
  })

  test('behavior: context overrides account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[0],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    httpServer.close()
  })

  test('behavior: throws when no account provided', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          getClient: () => createClient({ chain, transport: http() }),
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    await expect(fetch(httpServer.url)).rejects.toThrow(
      'No `account` provided. Pass `account` to parameters or context.',
    )

    httpServer.close()
  })

  test('behavior: passes through non-402 responses', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(200)
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')

    httpServer.close()
  })

  test('behavior: fee payer', async () => {
    const serverWithFeePayer = Mppx_server.create({
      methods: [
        tempo_server.charge({
          feePayer: accounts[0],
          getClient: () => client,
        }),
      ],
      realm,
      secretKey,
    })

    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        serverWithFeePayer.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect({
      ...receipt,
      reference: '[reference]',
      timestamp: '[timestamp]',
    }).toMatchInlineSnapshot(`
      {
        "method": "tempo",
        "reference": "[reference]",
        "status": "success",
        "timestamp": "[timestamp]",
      }
    `)

    httpServer.close()
  })

  test('behavior: fee payer with plain chain client (no Tempo serializers)', async () => {
    const plainChain = defineChain({
      id: chain.id,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: chain.rpcUrls,
    })
    const plainClient = createClient({
      account: accounts[1],
      chain: plainChain,
      transport: http(rpcUrl),
    })

    const serverWithFeePayer = Mppx_server.create({
      methods: [
        tempo_server.charge({
          feePayer: accounts[0],
          getClient: () => client,
        }),
      ],
      realm,
      secretKey,
    })

    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => plainClient,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        serverWithFeePayer.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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

  test('behavior: onChallenge can create credential', async () => {
    const onChallenge = vi.fn(async (_challenge, { createCredential }) =>
      createCredential({ account: accounts[1] }),
    )

    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          getClient: () => client,
        }),
      ],
      onChallenge,
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(onChallenge).toHaveBeenCalledTimes(1)

    httpServer.close()
  })
})

// Minimal mock method — createCredential is only invoked on the 402 retry path.
const noopMethod = {
  name: 'test',
  intent: 'test',
  context: undefined,
  createCredential: async () => 'credential',
} as any

/** Builds a valid 402 response with a WWW-Authenticate header. */
function make402(overrides?: { expires?: string; intent?: string; method?: string }) {
  const method = overrides?.method ?? 'test'
  const intent = overrides?.intent ?? 'test'
  const expires = overrides?.expires ? `, expires="${overrides.expires}"` : ''
  const request = btoa(JSON.stringify({ amount: '1' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const header = `Payment id="abc", realm="test", method="${method}", intent="${intent}", request="${request}"${expires}`
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': header },
  })
}

describe('Fetch.from: init passthrough (non-402)', () => {
  test('preserves init object identity while adding Accept-Payment', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const customInit = {
      method: 'POST',
      headers: { 'X-Custom': 'value' },
      body: JSON.stringify({ data: 'test' }),
    }

    await fetch('https://example.com/ws-upgrade', customInit)

    expect(receivedInits[0]).toBe(customInit)
    const headers = new Headers(receivedInits[0]?.headers)
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Accept-Payment')).toBe('test/test')
  })

  test('preserves extra properties on init for non-402 responses', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const customInit = {
      method: 'GET',
      headers: { Authorization: 'Bearer token123' },
      signal: AbortSignal.timeout(5000),
    }

    await fetch('https://example.com/api', customInit)

    const received = receivedInits[0]!
    expect(received.method).toBe('GET')
    expect(new Headers(received.headers).get('Authorization')).toBe('Bearer token123')
    expect(new Headers(received.headers).get('Accept-Payment')).toBe('test/test')
    expect(received.signal).toBe(customInit.signal)
  })

  test('passes through undefined init', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('passes init with context through untouched', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const customInit = { method: 'POST', context: { account: '0xabc' } }
    await fetch('https://example.com/api', customInit as any)

    expect(receivedInits[0]).toBe(customInit)
    expect((receivedInits[0] as Record<string, unknown>).context).toEqual({ account: '0xabc' })
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('preserves Request-carried headers when injecting Accept-Payment', async () => {
    const receivedInputs: (RequestInfo | URL)[] = []
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      receivedInputs.push(input)
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const request = new Request('https://example.com/api', {
      headers: { Authorization: 'Bearer token123', 'X-Custom': 'value' },
    })

    await fetch(request)

    expect(receivedInputs[0]).toBe(request)
    const headers = new Headers(receivedInits[0]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer token123')
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Accept-Payment')).toBe('test/test')
  })

  test('does not overwrite an explicit Accept-Payment header', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'custom/charge;q=0.5' },
    })

    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('custom/charge;q=0.5')
  })

  test('uses an explicit Accept-Payment header to reprioritize challenge selection', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe(
          'stripe/charge, tempo/charge;q=0.1',
        )

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('stripe-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'stripe/charge, tempo/charge;q=0.1' },
    })
    expect(response.status).toBe(200)
  })

  test('applies an explicit method opt-out before broader wildcard preferences', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe(
          'tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5',
        )

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('stripe-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5' },
    })
    expect(response.status).toBe(200)
  })

  test('preserves non-header init fields across all non-402 status codes', async () => {
    for (const status of [200, 201, 204, 301, 400, 401, 403, 404, 500, 503]) {
      const receivedInits: (RequestInit | undefined)[] = []
      const mockFetch: typeof globalThis.fetch = async (_input, init) => {
        receivedInits.push(init)
        return new Response(null, { status })
      }

      const fetch = Fetch.from({
        fetch: mockFetch,
        methods: [noopMethod],
      })

      const customInit = { method: 'GET' }
      await fetch('https://example.com/api', customInit)
      expect(receivedInits[0]?.method).toBe(customInit.method)
      expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
    }
  })
})

describe('Fetch.from: 402 retry path', () => {
  test('rejects expired challenges before hooks or credential creation', async () => {
    const createCredential = vi.fn(async () => 'credential')
    const onChallenge = vi.fn(async () => undefined)
    const mockFetch = vi.fn(async () =>
      make402({ expires: new Date(Date.now() - 60_000).toISOString() }),
    )
    const fetch = Fetch.from({
      fetch: mockFetch as typeof globalThis.fetch,
      methods: [{ ...noopMethod, createCredential }],
      onChallenge,
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(Errors.PaymentExpiredError)
    expect(onChallenge).not.toHaveBeenCalled()
    expect(createCredential).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test('strips context from init on retry', async () => {
    const calls: { init: RequestInit | undefined }[] = []
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      method: 'POST',
      context: { account: '0xabc' },
    } as any)

    expect(calls).toHaveLength(2)
    const retryInit = calls[1]!.init as Record<string, unknown>
    expect(retryInit).not.toHaveProperty('context')
  })

  test('adds Authorization header on retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api')

    const retryInit = calls[1]!.init as Record<string, unknown>
    const headers = retryInit.headers as Record<string, string>
    expect(headers.Authorization).toBe('credential')
  })

  test('emits client events and allows challenge handler to provide credential', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'method-credential')
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const method = { ...noopMethod, createCredential }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      events.push(`*:${event.name}`)
    })
    eventDispatcher.on('challenge.received', async (payload) => {
      events.push(`challenge:${payload.challenge.id}`)
      return 'event-credential'
    })
    eventDispatcher.on('credential.created', (payload) => {
      events.push(`credential:${payload.credential}`)
      throw new Error('observer failed')
    })
    eventDispatcher.on('payment.response', (payload) => {
      events.push(`response:${payload.response.status}`)
      throw new Error('observer failed')
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(createCredential).not.toHaveBeenCalled()
    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('event-credential')
    expect(events).toEqual([
      'challenge:abc',
      '*:challenge.received',
      'credential:event-credential',
      '*:credential.created',
      'response:200',
      '*:payment.response',
    ])
  })

  test('uses the first challenge event credential', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('challenge.received', () => {
      events.push('first')
      return 'first-credential'
    })
    eventDispatcher.on('challenge.received', () => {
      events.push('second')
      return 'second-credential'
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(createCredential).not.toHaveBeenCalled()
    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('first-credential')
    expect(events).toEqual(['first'])
  })

  test('does not emit payment.response for non-ok retry responses', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response('Internal Server Error', { status: 500 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('payment.response', (payload) => {
      events.push(`response:${payload.response.status}`)
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(500)
    expect(events).toEqual([])
  })

  test('ignores empty challenge event credentials and continues handlers', async () => {
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('challenge.received', () => '')
    eventDispatcher.on('challenge.received', () => 'second-credential')

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(createCredential).not.toHaveBeenCalled()
    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('second-credential')
  })

  test('memoizes createCredential across wildcard observers and fallback', async () => {
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', async (event) => {
      if (event.name === 'challenge.received') await event.payload.createCredential()
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('does not expose live challenges or init headers to observers', async () => {
    const createCredential = vi.fn(async ({ challenge }) => `amount:${challenge.request.amount}`)
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      if (event.name !== 'challenge.received') return
      try {
        ;(event.payload.challenge.request as { amount: string }).amount = '999'
      } catch {}
      const headers = new Headers(event.payload.init?.headers)
      headers.set('Authorization', 'attacker')
      if (event.payload.init) event.payload.init.headers = headers
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api', {
      headers: { 'X-Test': '1' },
    })

    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('amount:1')
  })

  test('continues dispatching observer listeners after one throws', async () => {
    const events: string[] = []
    const method = { ...noopMethod, createCredential: vi.fn(async () => 'credential') }
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('credential.created', () => {
      events.push('first')
      throw new Error('observer failed')
    })
    eventDispatcher.on('credential.created', () => {
      events.push('second')
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(events).toEqual(['first', 'second'])
  })

  test('emits payment.failed when automatic payment handling rejects', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'credential')
    const mockFetch = vi.fn(async () =>
      make402({ expires: new Date(Date.now() - 60_000).toISOString() }),
    )
    const method = { ...noopMethod, createCredential }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      events.push(`*:${event.name}`)
    })
    eventDispatcher.on('payment.failed', (payload) => {
      events.push(
        `failed:${payload.error instanceof Errors.PaymentExpiredError}:${payload.challenge?.id}`,
      )
      throw new Error('observer failed')
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch as typeof globalThis.fetch,
      methods: [method],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(Errors.PaymentExpiredError)
    expect(createCredential).not.toHaveBeenCalled()
    expect(events).toEqual(['failed:true:abc', '*:payment.failed'])
  })

  test('preserves existing headers on retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      headers: { 'X-Custom': 'value', 'Content-Type': 'application/json' },
    })

    const retryInit = calls[1]!.init as Record<string, unknown>
    const headers = new Headers(retryInit.headers as HeadersInit)
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept-Payment')).toBe('test/test')
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('preserves method and other init properties on retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      method: 'PUT',
      body: JSON.stringify({ data: 'test' }),
      credentials: 'include',
      mode: 'cors',
    })

    const retryInit = calls[1]!.init as Record<string, unknown>
    expect(retryInit.method).toBe('PUT')
    expect(retryInit.body).toBe(JSON.stringify({ data: 'test' }))
    expect(retryInit.credentials).toBe('include')
    expect(retryInit.mode).toBe('cors')
  })

  test('handles undefined init on 402 retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api')

    expect(calls).toHaveLength(2)
    const retryInit = calls[1]!.init as Record<string, unknown>
    const headers = new Headers(retryInit.headers as HeadersInit)
    expect(headers.get('Accept-Payment')).toBe('test/test')
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('preserves Request-carried headers on retry after injecting Accept-Payment', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ init, input })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const request = new Request('https://example.com/api', {
      headers: { Authorization: 'Bearer token123', 'X-Custom': 'value' },
    })

    await fetch(request)

    expect(calls[0]?.input).toBe(request)
    expect(calls[1]?.input).toBe(request)
    const headers = new Headers(calls[1]?.init?.headers)
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Accept-Payment')).toBe('test/test')
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('selects the highest-ranked supported challenge', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe(
          'tempo/charge, stripe/charge;q=0.5',
        )

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('tempo-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
      acceptPayment: {
        definition: { 'stripe/charge': 0.5 },
        entries: [
          { intent: 'charge', method: 'tempo', q: 1, index: 0 },
          { intent: 'charge', method: 'stripe', q: 0.5, index: 1 },
        ],
        header: 'tempo/charge, stripe/charge;q=0.5',
        keys: {
          stripe: { charge: 'stripe/charge' },
          tempo: { charge: 'tempo/charge' },
        },
      },
    })

    const response = await fetch('https://example.com/api')
    expect(response.status).toBe(200)
  })

  test('orderChallenges filters and sorts supported challenges before signing', async () => {
    let callCount = 0
    const pathUsd = Challenge.from({
      id: 'pathusd',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { chainId: 11155111, currency: 'pathusd' },
    })
    const usdc = Challenge.from({
      id: 'usdc',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { chainId: 8453, currency: 'usdc' },
    })
    const createCredential = vi.fn(
      async ({ challenge }: { challenge: Challenge.Challenge }) => `credential-${challenge.id}`,
    )

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': `${Challenge.serialize(pathUsd)}, ${Challenge.serialize(usdc)}`,
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('credential-usdc')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.request.currency === 'usdc'),
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(createCredential).toHaveBeenCalledOnce()
    expect(createCredential.mock.calls[0]?.[0].challenge.id).toBe('usdc')
  })

  test('request-local orderChallenges overrides configured ordering', async () => {
    let callCount = 0
    const first = Challenge.from({
      id: 'first',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { currency: 'first' },
    })
    const second = Challenge.from({
      id: 'second',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { currency: 'second' },
    })
    const createCredential = vi.fn(
      async ({ challenge }: { challenge: Challenge.Challenge }) => `credential-${challenge.id}`,
    )

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': `${Challenge.serialize(first)}, ${Challenge.serialize(second)}`,
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('credential-second')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.id === 'first'),
    })

    const response = await fetch('https://example.com/api', {
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.id === 'second'),
    })

    expect(response.status).toBe(200)
    expect(createCredential.mock.calls[0]?.[0].challenge.id).toBe('second')
  })

  test('throws when orderChallenges rejects every supported challenge', async () => {
    const mockFetch: typeof globalThis.fetch = async () => make402()
    const createCredential = vi.fn(async () => 'credential')

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
      orderChallenges: () => [],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(
      'No method found for challenges: test.test',
    )
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('falls back to configured preferences when explicit Accept-Payment is invalid', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe('not a valid header')

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('tempo-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
      acceptPayment: {
        definition: { 'stripe/charge': 0.5 },
        entries: [
          { intent: 'charge', method: 'tempo', q: 1, index: 0 },
          { intent: 'charge', method: 'stripe', q: 0.5, index: 1 },
        ],
        header: 'tempo/charge, stripe/charge;q=0.5',
        keys: {
          stripe: { charge: 'stripe/charge' },
          tempo: { charge: 'tempo/charge' },
        },
      },
    })

    const response = await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'not a valid header' },
    })
    expect(response.status).toBe(200)
  })

  test('throws when no matching method for 402 challenge', async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      make402({ method: 'stripe', intent: 'charge' })

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(
      'No method found for challenges: stripe.charge',
    )
  })

  test('retries exactly once — does not loop on repeated 402', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      return make402()
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const response = await fetch('https://example.com/api')
    expect(callCount).toBe(2)
    expect(response.status).toBe(402)
  })
})

describe('Fetch.from: acceptPaymentPolicy', () => {
  test('policy: "always" injects Accept-Payment on all requests', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'always',
    })

    await fetch('https://cross-origin.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('policy: "never" skips Accept-Payment on all requests', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'never',
    })

    await fetch('https://example.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBeNull()
  })

  test('policy: "same-origin" injects when no globalThis.location (server-side)', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'same-origin',
    })

    await fetch('https://example.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('policy: { origins } injects only for matching origins', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: { origins: ['https://pay.example.com'] },
    })

    await fetch('https://pay.example.com/resource')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://other.example.com/resource')
    expect(new Headers(receivedInits[1]?.headers).get('Accept-Payment')).toBeNull()
  })

  test('policy: { origins } matches origin regardless of path', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: { origins: ['https://pay.example.com/some/path'] },
    })

    await fetch('https://pay.example.com/different/path')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('policy: { origins } supports wildcard subdomains', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: { origins: ['*.example.com'] },
    })

    await fetch('https://pay.example.com/resource')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://api.pay.example.com/resource')
    expect(new Headers(receivedInits[1]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://example.com/resource')
    expect(new Headers(receivedInits[2]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://notexample.com/resource')
    expect(new Headers(receivedInits[3]?.headers).get('Accept-Payment')).toBeNull()
  })

  test('policy: "never" still handles 402 responses', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBeNull()
        return make402()
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'never',
    })

    const response = await fetch('https://example.com/api')
    expect(response.status).toBe(200)
  })

  test('policy: explicit Accept-Payment header always takes precedence over "never"', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'never',
    })

    await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'custom/charge' },
    })
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('custom/charge')
  })

  test('defaults to "always" for Fetch.from', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://cross-origin.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })
})

describe('Fetch.from: input passthrough', () => {
  test('passes URL input through on both initial and retry calls', async () => {
    let callCount = 0
    const receivedInputs: (RequestInfo | URL)[] = []
    const mockFetch: typeof globalThis.fetch = async (input, _init) => {
      receivedInputs.push(input)
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const url = new URL('https://example.com/resource')
    await fetch(url)

    expect(receivedInputs[0]).toBe(url)
    expect(receivedInputs[1]).toBe(url)
  })
})

describe('Fetch.polyfill', () => {
  test('default', async () => {
    Fetch.polyfill({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect({
      ...receipt,
      reference: '[reference]',
      timestamp: '[timestamp]',
    }).toMatchInlineSnapshot(`
      {
        "method": "tempo",
        "reference": "[reference]",
        "status": "success",
        "timestamp": "[timestamp]",
      }
    `)

    httpServer.close()
    Fetch.restore()
  })
})

describe('Fetch.polyfill / restore', () => {
  test('restore is a no-op when polyfill was never called', () => {
    const before = globalThis.fetch
    Fetch.restore()
    expect(globalThis.fetch).toBe(before)
  })

  test('restore reverts to original fetch', () => {
    const originalFetch = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    expect(globalThis.fetch).not.toBe(originalFetch)

    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('stacked polyfill calls preserve the true original fetch', () => {
    const originalFetch = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    const firstPolyfill = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    expect(globalThis.fetch).not.toBe(firstPolyfill)

    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('double restore does not clobber fetch', () => {
    const originalFetch = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)

    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('restore is a no-op when fetch was replaced externally after polyfill', () => {
    const originalFetch = globalThis.fetch
    const externalFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('external', { status: 200 }),
    ) as unknown as typeof globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    globalThis.fetch = externalFetch

    Fetch.restore()
    expect(globalThis.fetch).toBe(externalFetch)

    globalThis.fetch = originalFetch
  })
})
