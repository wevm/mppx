import { describe, expect, test } from 'vitest'
import * as Fetch from './Fetch.js'

// Minimal mock method — we never hit 402, so this is never invoked
const noopMethod = {
  name: 'test',
  intent: 'test',
  context: undefined,
  createCredential: async () => 'credential',
} as any

describe('Fetch.from: init passthrough', () => {
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
      // Simulates extra props that SDKs may attach
      signal: AbortSignal.timeout(5000),
    }

    await fetch('https://example.com/api', customInit)

    // init should arrive with all original properties intact
    const received = receivedInits[0]!
    expect(received.method).toBe('GET')
    expect((received.headers as Record<string, string>).Authorization).toBe('Bearer token123')
    expect(received.signal).toBe(customInit.signal)
  })
})
