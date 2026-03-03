import { Receipt } from 'mppx'
import { tempo } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { createClient } from 'viem'
import { describe, expect, test, vi } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, chain, client, http } from '~test/tempo/viem.js'
import * as Fetch from './Fetch.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mppx_server.create({
  methods: [
    tempo_server({
      getClient: () => client,
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

// Minimal mock method — we never hit 402, so createCredential is only
// invoked on the 402 retry path (returns a fixed credential string).
const noopMethod = {
  name: 'test',
  intent: 'test',
  context: undefined,
  createCredential: async () => 'credential',
} as any

/** Builds a valid 402 response with a WWW-Authenticate header. */
function make402(overrides?: { method?: string; intent?: string }) {
  const method = overrides?.method ?? 'test'
  const intent = overrides?.intent ?? 'test'
  const request = btoa(JSON.stringify({ amount: '1' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const header = `Payment id="abc", realm="test", method="${method}", intent="${intent}", request="${request}"`
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': header },
  })
}

describe('Fetch.from: init passthrough (non-402)', () => {
  test('passes unmodified init to underlying fetch for non-402 responses', async () => {
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

    // The underlying fetch should receive the EXACT same object reference,
    // not a destructured copy with `context` stripped out
    expect(receivedInits[0]).toBe(customInit)
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
    expect((received.headers as Record<string, string>).Authorization).toBe('Bearer token123')
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
    expect(receivedInits[0]).toBeUndefined()
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
  })

  test('preserves object identity across all non-402 status codes', async () => {
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
      expect(receivedInits[0]).toBe(customInit)
    }
  })
})

describe('Fetch.from: 402 retry path', () => {
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
    const headers = retryInit.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('value')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('credential')
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
    expect(retryInit.headers).toEqual({ Authorization: 'credential' })
  })

  test('throws when no matching method for 402 challenge', async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      make402({ method: 'stripe', intent: 'charge' })

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(
      'No method found for "stripe.charge"',
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

describe('Fetch.from: 402 retry headers normalization', () => {
  test('preserves headers when passed as a Headers instance', async () => {
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

    const headers = new Headers({ 'X-Custom': 'value', 'Content-Type': 'application/json' })
    await fetch('https://example.com/api', { headers })

    const retryHeaders = (calls[1]!.init as Record<string, unknown>).headers as Record<
      string,
      string
    >
    expect(retryHeaders['x-custom']).toBe('value')
    expect(retryHeaders['content-type']).toBe('application/json')
    expect(retryHeaders.Authorization).toBe('credential')
  })

  test('preserves headers when passed as array of tuples', async () => {
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
      headers: [
        ['X-Custom', 'value'],
        ['Accept', 'application/json'],
      ],
    })

    const retryHeaders = (calls[1]!.init as Record<string, unknown>).headers as Record<
      string,
      string
    >
    expect(retryHeaders['X-Custom']).toBe('value')
    expect(retryHeaders.Accept).toBe('application/json')
    expect(retryHeaders.Authorization).toBe('credential')
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
})
