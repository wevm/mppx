import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as Store from '../../../Store.js'
import * as Tap from './index.js'

const url = 'https://agent-provider.example/.well-known/jwks.json'

afterEach(() => {
  vi.useRealTimers()
})

const algorithms = [
  ['ed25519', { name: 'Ed25519' }, 'EdDSA'],
  ['ecdsa-p256-sha256', { name: 'ECDSA', namedCurve: 'P-256' }, 'ES256'],
  ['ecdsa-p384-sha384', { name: 'ECDSA', namedCurve: 'P-384' }, 'ES384'],
  [
    'rsa-pss-sha512',
    {
      name: 'RSA-PSS',
      hash: 'SHA-512',
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    'PS512',
  ],
] as const

async function generate(parameters: (typeof algorithms)[number][1]) {
  return (await crypto.subtle.generateKey(parameters, true, ['sign', 'verify'])) as CryptoKeyPair
}

async function jwkOf(keys: CryptoKeyPair, members: Record<string, unknown> = {}) {
  const { key_ops: _, ext: __, ...jwk } = await crypto.subtle.exportKey('jwk', keys.publicKey)
  return { ...jwk, kid: 'agent', ...members }
}

function server(...sets: unknown[]) {
  const fetch = vi.fn(async () => {
    const next = sets.length > 1 ? sets.shift() : sets[0]
    if (next instanceof Response) return next.clone()
    if (next instanceof Error) throw next
    return Response.json(next)
  })
  return fetch as unknown as typeof globalThis.fetch & typeof fetch
}

describe.each(algorithms)('%s', (algorithm, parameters, alg) => {
  test('verifies a TAP signature with a key from the set', async () => {
    const keys = await generate(parameters)
    const verifier = Tap.Server.verifier({
      keyResolver: Tap.Jwks.resolver({
        fetch: server({ keys: [await jwkOf(keys, { alg })] }),
        url,
      }),
      nonceStore: Store.memory(),
    })
    const signed = await Tap.Client.prover({
      intent: 'payment',
      key: keys,
      keyId: 'agent',
      scope: '*',
    }).prove(new Request('https://merchant.example/checkout'), {
      created: Math.floor(Date.now() / 1_000),
      nonce: crypto.randomUUID(),
    })
    expect(await verifier.verify(signed)).toMatchObject({
      status: 'valid',
      value: { keyId: 'agent' },
    })
    void algorithm
  })
})

describe('refuses a key', () => {
  test.each([
    ['for another algorithm', { alg: 'ES384' }],
    ['for encryption', { use: 'enc' }],
    ['without the verify operation', { key_ops: ['sign'] }],
  ])('%s', async (_, members) => {
    const keys = await generate({ name: 'ECDSA', namedCurve: 'P-256' })
    const resolve = Tap.Jwks.resolver({
      fetch: server({ keys: [await jwkOf(keys, members)] }),
      url,
    })
    expect(
      await resolve({ algorithm: 'ecdsa-p256-sha256', keyId: 'agent', request: new Request(url) }),
    ).toBe(undefined)
  })

  test('whose curve does not fit the signature algorithm', async () => {
    const keys = await generate({ name: 'ECDSA', namedCurve: 'P-256' })
    const resolve = Tap.Jwks.resolver({ fetch: server({ keys: [await jwkOf(keys)] }), url })
    expect(
      await resolve({ algorithm: 'ecdsa-p384-sha384', keyId: 'agent', request: new Request(url) }),
    ).toBe(undefined)
    expect(await resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) })).toBe(
      undefined,
    )
  })

  test('whose kid appears twice', async () => {
    const keys = await generate({ name: 'Ed25519' })
    const jwk = await jwkOf(keys)
    const resolve = Tap.Jwks.resolver({ fetch: server({ keys: [jwk, jwk] }), url })
    expect(await resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) })).toBe(
      undefined,
    )
  })
})

test('imports only the public members of a key', async () => {
  const keys = await generate({ name: 'Ed25519' })
  const { d } = await crypto.subtle.exportKey('jwk', keys.privateKey)
  const resolve = Tap.Jwks.resolver({ fetch: server({ keys: [await jwkOf(keys, { d })] }), url })
  const key = await resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) })
  expect(key?.type).toBe('public')
})

test('requires an https URL', () => {
  expect(() => Tap.Jwks.resolver({ url: 'http://agent-provider.example/jwks.json' })).toThrow(
    'A TAP JWKS URL must use https.',
  )
})

describe('caching', () => {
  async function setup(...sets: unknown[]) {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const keys = await generate({ name: 'Ed25519' })
    const jwk = await jwkOf(keys)
    const fetch = server(...sets.map((set) => (set === 'keys' ? { keys: [jwk] } : set)))
    const resolve = Tap.Jwks.resolver({ fetch, maxStale: 600, refreshInterval: 30, ttl: 60, url })
    const lookup = (keyId = 'agent') =>
      resolve({ algorithm: 'ed25519', keyId, request: new Request(url) })
    return { fetch, lookup }
  }

  test('serves a known key from the cache within ttl', async () => {
    const { fetch, lookup } = await setup('keys')
    await lookup()
    vi.setSystemTime(1_000_000 + 59_000)
    expect(await lookup()).toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('shares one fetch between concurrent cold lookups', async () => {
    const { fetch, lookup } = await setup('keys')
    const results = await Promise.all([lookup(), lookup(), lookup()])
    expect(results.every(Boolean)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('refetches for an unknown key ID at most once per refreshInterval', async () => {
    const { fetch, lookup } = await setup('keys')
    await lookup()
    // Within refreshInterval of the first fetch, the cached set answers.
    expect(await lookup('unknown')).toBe(undefined)
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(1_000_000 + 31_000)
    expect(await lookup('unknown')).toBe(undefined)
    expect(await lookup('unknown')).toBe(undefined)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('serves a stale set through an outage until maxStale, then fails closed', async () => {
    const { lookup } = await setup('keys', new Error('down'))
    await lookup()
    vi.setSystemTime(1_000_000 + 120_000)
    expect(await lookup()).toBeDefined()
    vi.setSystemTime(1_000_000 + 601_000)
    await expect(lookup()).rejects.toThrow()
  })

  test('does not call an unknown key ID unknown while the refetch fails', async () => {
    const { lookup } = await setup('keys', new Error('down'))
    await lookup()
    vi.setSystemTime(1_000_000 + 31_000)
    await expect(lookup('rotated-in')).rejects.toThrow('down')
  })

  test.each([
    ['a non-ok response', new Response('no', { status: 500 }), 'JWKS request failed with 500.'],
    ['a body without keys', { nope: true }, 'JWKS response has no keys list.'],
  ])('fails on %s', async (_, set, message) => {
    const { lookup } = await setup(set)
    await expect(lookup()).rejects.toThrow(message)
  })
})

describe('accepts a key', () => {
  test.each([
    ['without alg, use or key_ops', {}],
    ['for signatures', { use: 'sig' }],
    ['with the verify operation', { key_ops: ['verify'] }],
  ])('%s', async (_, members) => {
    const keys = await generate({ name: 'Ed25519' })
    const { alg: _alg, ...jwk } = await jwkOf(keys, members)
    const resolve = Tap.Jwks.resolver({ fetch: server({ keys: [jwk] }), url })
    expect(
      await resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) }),
    ).toBeDefined()
  })

  test('past entries that are not keys', async () => {
    const keys = await generate({ name: 'Ed25519' })
    const jwk = await jwkOf(keys)
    const resolve = Tap.Jwks.resolver({
      fetch: server({ keys: [null, 'x', { kty: 'OKP' }, { kid: 1 }, jwk] }),
      url,
    })
    expect(
      await resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) }),
    ).toBeDefined()
  })
})

test('answers a key that does not import with undefined', async () => {
  const resolve = Tap.Jwks.resolver({
    fetch: server({ keys: [{ crv: 'Ed25519', kid: 'agent', kty: 'OKP', x: 'not-a-key' }] }),
    url,
  })
  expect(await resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) })).toBe(
    undefined,
  )
})

test('fetches without following redirects or paying', async () => {
  const keys = await generate({ name: 'Ed25519' })
  const fetch = server({ keys: [await jwkOf(keys)] })
  await Tap.Jwks.resolver({ fetch, url })({
    algorithm: 'ed25519',
    keyId: 'agent',
    request: new Request(url),
  })
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(String(target)).toBe(url)
  expect(init.redirect).toBe('manual')
  expect(new Headers(init.headers).get('accept')).toBe('application/jwk-set+json, application/json')
})

describe('timing', () => {
  async function setup(options: Partial<Tap.Jwks.resolver.Options>, ...sets: unknown[]) {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const keys = await generate({ name: 'Ed25519' })
    const jwk = await jwkOf(keys)
    const fetch = server(...sets.map((set) => (set === 'keys' ? { keys: [jwk] } : set)))
    const resolve = Tap.Jwks.resolver({ fetch, url, ...options })
    const lookup = (keyId = 'agent') =>
      resolve({ algorithm: 'ed25519', keyId, request: new Request(url) })
    return { fetch, lookup }
  }

  test('caches for 300 seconds and refetches after 30 by default', async () => {
    const { fetch, lookup } = await setup({}, 'keys')
    await lookup()
    vi.setSystemTime(1_000_000 + 300_000)
    await lookup()
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(1_000_000 + 300_001)
    await lookup()
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(1_000_000 + 300_001 + 29_999)
    await lookup('unknown')
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(1_000_000 + 300_001 + 30_000)
    await lookup('unknown')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('serves a stale set exactly until maxStale', async () => {
    const { lookup } = await setup(
      { maxStale: 600, refreshInterval: 30, ttl: 60 },
      'keys',
      new Error('down'),
    )
    await lookup()
    vi.setSystemTime(1_000_000 + 600_000)
    expect(await lookup()).toBeDefined()
    vi.setSystemTime(1_000_000 + 600_001)
    await expect(lookup()).rejects.toThrow('The JWKS is unavailable.')
  })

  test('fails closed between retries when no set was ever fetched', async () => {
    const { lookup } = await setup({}, new Error('down'))
    await expect(lookup()).rejects.toThrow('down')
    await expect(lookup()).rejects.toThrow('The JWKS is unavailable.')
  })
})

test('fails closed when a refetch fails after maxStale has passed', async () => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  const keys = await generate({ name: 'Ed25519' })
  const jwk = await jwkOf(keys)
  let calls = 0
  const fetch = (async () => {
    calls++
    if (calls === 1) return Response.json({ keys: [jwk] })
    // The refetch starts before the deadline and fails after it.
    vi.setSystemTime(1_000_000 + 61_000)
    throw new Error('down')
  }) as typeof globalThis.fetch
  const resolve = Tap.Jwks.resolver({ fetch, maxStale: 60, refreshInterval: 1, ttl: 10, url })
  const lookup = () => resolve({ algorithm: 'ed25519', keyId: 'agent', request: new Request(url) })
  await lookup()
  vi.setSystemTime(1_000_000 + 59_000)
  await expect(lookup()).rejects.toThrow('down')
})
