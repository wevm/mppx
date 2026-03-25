import { describe, expect, test, vi } from 'vp/test'

import * as Fetch from './Fetch.js'

const noopMethod = {
  name: 'test',
  intent: 'test',
  context: undefined,
  createCredential: async () => 'credential',
} as any

function make402() {
  const request = btoa(JSON.stringify({ amount: '1' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return new Response(null, {
    status: 402,
    headers: {
      'WWW-Authenticate': `Payment id="abc", realm="test", method="test", intent="test", request="${request}"`,
    },
  })
}

/** Returns a fetch wrapper and the init captured from the 402 retry call. */
function setup() {
  const calls: (RequestInit | undefined)[] = []
  let callCount = 0
  const mockFetch: typeof globalThis.fetch = async (_input, init) => {
    calls.push(init)
    callCount++
    if (callCount === 1) return make402()
    return new Response('OK', { status: 200 })
  }
  const fetch = Fetch.from({ fetch: mockFetch, methods: [noopMethod] })
  return {
    fetch,
    /** Headers sent on the retry (second) request. */
    retryHeaders: async (input: RequestInfo | URL, init?: RequestInit) => {
      await fetch(input, init)
      return (calls[1] as Record<string, unknown>)?.headers as Record<string, string>
    },
  }
}

describe('Fetch.from: browser header normalization', () => {
  test('preserves Headers instance', async () => {
    const { retryHeaders } = setup()
    const h = await retryHeaders('https://example.com', {
      headers: new Headers({ 'X-Custom': 'value', 'Content-Type': 'application/json' }),
    })
    expect(h['x-custom']).toBe('value')
    expect(h['content-type']).toBe('application/json')
    expect(h.Authorization).toBe('credential')
  })

  test('preserves header tuples', async () => {
    const { retryHeaders } = setup()
    const h = await retryHeaders('https://example.com', {
      headers: [
        ['X-Custom', 'value'],
        ['Accept', 'application/json'],
      ],
    })
    expect(h['X-Custom']).toBe('value')
    expect(h.Accept).toBe('application/json')
    expect(h.Authorization).toBe('credential')
  })

  test('replaces authorization case-insensitively', async () => {
    const { retryHeaders } = setup()
    const h = await retryHeaders('https://example.com', {
      headers: { authorization: 'Bearer stale', 'X-Custom': 'value' },
    })
    expect(h.authorization).toBeUndefined()
    expect(h.Authorization).toBe('credential')
    expect(h['X-Custom']).toBe('value')
  })

  test('preserves plain object headers', async () => {
    const { retryHeaders } = setup()
    const h = await retryHeaders('https://example.com', { headers: { 'X-Custom': 'val' } })
    expect(h['X-Custom']).toBe('val')
    expect(h.Authorization).toBe('credential')
  })

  test('adds Authorization when no headers provided', async () => {
    const { retryHeaders } = setup()
    const h = await retryHeaders('https://example.com')
    expect(h.Authorization).toBe('credential')
  })
})

describe('Fetch.polyfill / restore: browser', () => {
  test('restore is a no-op when polyfill was never called', () => {
    const before = globalThis.fetch
    Fetch.restore()
    expect(globalThis.fetch).toBe(before)
  })

  test('restore reverts to original fetch', () => {
    const original = globalThis.fetch
    Fetch.polyfill({ methods: [noopMethod] })
    expect(globalThis.fetch).not.toBe(original)
    Fetch.restore()
    expect(globalThis.fetch).toBe(original)
  })

  test('stacked polyfill calls preserve the true original', () => {
    const original = globalThis.fetch
    Fetch.polyfill({ methods: [noopMethod] })
    Fetch.polyfill({ methods: [noopMethod] })
    Fetch.restore()
    expect(globalThis.fetch).toBe(original)
  })

  test('double restore does not clobber fetch', () => {
    const original = globalThis.fetch
    Fetch.polyfill({ methods: [noopMethod] })
    Fetch.restore()
    Fetch.restore()
    expect(globalThis.fetch).toBe(original)
  })

  test('restore is a no-op when fetch was replaced externally', () => {
    const original = globalThis.fetch
    const external = vi.fn(
      async () => new Response('external'),
    ) as unknown as typeof globalThis.fetch
    Fetch.polyfill({ methods: [noopMethod] })
    globalThis.fetch = external
    Fetch.restore()
    expect(globalThis.fetch).toBe(external)
    globalThis.fetch = original
  })
})
