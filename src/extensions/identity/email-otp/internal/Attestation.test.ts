import { expect, test } from 'vp/test'
import { jwkThumbprint, keyPair } from '~test/Identity.js'

import * as Attestation from './index.js'

const issuer = 'https://issuer.example'
const audience = 'https://api.example'
const now = 1_800_000_000

async function setup() {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const claims: Attestation.Claims = {
    aud: audience,
    exp: now + 600,
    iat: now,
    iss: issuer,
    jti: 'id',
    sub: 'dana@example.com',
    type: 'email',
  }
  const options: Attestation.verify.Options = {
    audience,
    issuer,
    keyResolver: ({ keyId: kid }) => (kid === keyId ? keys.publicKey : undefined),
    now,
    type: 'email',
  }
  return { claims, keyId, keys, options }
}

test('signs and verifies an attestation', async () => {
  const { claims, keyId, keys, options } = await setup()
  const token = await Attestation.sign(claims, { key: keys.privateKey, keyId })
  expect(Attestation.decode(token)?.header).toEqual({
    alg: 'EdDSA',
    kid: keyId,
    typ: 'mpp-attestation+jwt',
  })
  expect(await Attestation.verify(token, options)).toEqual({ claims, status: 'valid' })
})

test('rejects wrong claims, times, keys and tampering', async () => {
  const { claims, keyId, keys, options } = await setup()
  const sign = (overrides: Partial<Attestation.Claims>) =>
    Attestation.sign({ ...claims, ...overrides }, { key: keys.privateKey, keyId })
  const reason = async (token: string, extra: Partial<Attestation.verify.Options> = {}) => {
    const result = await Attestation.verify(token, { ...options, ...extra })
    return result.status === 'invalid' ? result.reason : 'valid'
  }

  expect(await reason(await sign({ iss: 'https://evil.example' }))).toMatch(/issuer/)
  expect(await reason(await sign({ aud: 'https://other.example' }))).toMatch(/audience/)
  expect(await reason(await sign({ type: 'phone' }))).toMatch(/type/)
  expect(await reason(await sign({ exp: now - 61 }))).toMatch(/expired/)
  expect(await reason(await sign({ iat: now + 61 }))).toMatch(/future/)
  expect(await reason(await sign({ iat: now - 3_600 }), { maxAge: 60 })).toMatch(/too old/)
  expect(await reason(await sign({ jti: 1 as never }))).toMatch(/ID is malformed/)
  expect(await reason(await sign({ exp: 9_000_000_000_000 }))).toMatch(/times are malformed/)
  expect(await reason(await sign({}), { keyResolver: () => undefined })).toMatch(/No public key/)

  const other = await keyPair()
  const forged = await Attestation.sign(claims, { key: other.privateKey, keyId })
  expect(await reason(forged)).toMatch(/signature/)

  const [header, , signature] = (await sign({})).split('.')
  const payload = Buffer.from(JSON.stringify({ ...claims, sub: 'mallory@example.com' })).toString(
    'base64url',
  )
  expect(await reason(`${header}.${payload}.${signature}`)).toMatch(/signature/)

  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: keyId, typ: 'mpp-attestation+jwt' })).toString('base64url')}.${payload}.`
  expect(await reason(none)).toMatch(/malformed|algorithm/)
  expect(await reason('not-a-token')).toMatch(/malformed/)
})

test('resolves keys from the issuer JSON Web Key Set and caches them', async () => {
  const { claims, keyId, keys, options } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const requests: string[] = []
  const keyResolver = Attestation.Jwks.resolver({
    async fetch(input) {
      requests.push(String(input))
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
  })
  const token = await Attestation.sign(claims, { key: keys.privateKey, keyId })
  expect(await Attestation.verify(token, { ...options, keyResolver })).toMatchObject({
    status: 'valid',
  })
  expect(await Attestation.verify(token, { ...options, keyResolver })).toMatchObject({
    status: 'valid',
  })
  expect(await keyResolver({ issuer, keyId: 'unknown' })).toBeUndefined()
  expect(requests).toEqual([`${issuer}/.well-known/jwks.json`])
})

test('parses requirements and ignores malformed members', () => {
  const headers = new Headers({
    [Attestation.Constants.requiredHeader]:
      'email;issuer="https://a.example", phone;issuer=1, "x", sms;issuer="http://evil.example", kyc;issuer="https://b.example", dev;issuer="http://localhost:8787"',
  })
  expect(Attestation.Client.requirements(headers)).toEqual([
    { issuer: 'https://a.example', type: 'email' },
    { issuer: 'https://b.example', type: 'kyc' },
    { issuer: 'http://localhost:8787', type: 'dev' },
  ])
})

test('keeps the last key set when a refresh has no keys list', async () => {
  const { claims, keyId, keys, options } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let body: unknown = { keys: [{ ...jwk, kid: keyId }] }
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      return Response.json(body)
    },
    refreshInterval: 0,
    ttl: 0,
  })
  const token = await Attestation.sign(claims, { key: keys.privateKey, keyId })
  expect(await Attestation.verify(token, { ...options, keyResolver })).toMatchObject({
    status: 'valid',
  })
  body = { error: 'partial' }
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await Attestation.verify(token, { ...options, keyResolver })).toMatchObject({
    status: 'valid',
  })
})

test('keeps verifying with the last key set while the issuer is down', async () => {
  const { claims, keyId, keys, options } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let up = true
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      if (!up) throw new Error('down')
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
    refreshInterval: 0,
    ttl: 0,
  })
  const token = await Attestation.sign(claims, { key: keys.privateKey, keyId })
  expect(await Attestation.verify(token, { ...options, keyResolver })).toMatchObject({
    status: 'valid',
  })
  up = false
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await Attestation.verify(token, { ...options, keyResolver })).toMatchObject({
    status: 'valid',
  })
})

test('shares one key set fetch between concurrent unknown key IDs', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let requests = 0
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      requests++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
    refreshInterval: 0,
  })
  await keyResolver({ issuer, keyId })
  requests = 0
  await new Promise((resolve) => setTimeout(resolve, 2))
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => keyResolver({ issuer, keyId: `unknown-${i}` })),
  )
  expect(results.every((key) => key === undefined)).toBe(true)
  expect(requests).toBe(1)
})

test('serves a cached key while an unknown key ID refetches the set', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let hang = false
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      if (hang) return new Promise<Response>(() => {})
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
    refreshInterval: 0,
  })
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  hang = true
  await new Promise((resolve) => setTimeout(resolve, 2))
  void keyResolver({ issuer, keyId: 'unknown' })
  // Let the unknown key ID start its refetch.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const lookup = keyResolver({ issuer, keyId })
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))
  expect(await Promise.race([lookup, timedOut])).not.toBe('timeout')
})

test('skips a malformed key without dropping the rest of the set', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      return Response.json({
        keys: [
          { crv: 'Ed25519', kid: 'bad', kty: 'OKP', x: 'AA' },
          { ...jwk, kid: keyId },
        ],
      })
    },
  })
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  expect(await keyResolver({ issuer, keyId: 'bad' })).toBeUndefined()
})

test('stops serving the last key set once it is older than maxStale', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let up = true
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      if (!up) throw new Error('down')
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
    maxStale: 0.01,
    refreshInterval: 0,
    ttl: 0,
  })
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  up = false
  await new Promise((resolve) => setTimeout(resolve, 20))
  await expect(keyResolver({ issuer, keyId })).rejects.toThrow('down')
})

test('retries a failed key set fetch after refreshInterval, not ttl', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let up = false
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      if (!up) throw new Error('down')
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
    refreshInterval: 0.01,
    ttl: 300,
  })
  await expect(keyResolver({ issuer, keyId })).rejects.toThrow('down')
  up = true
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
})

test('verifies one token however many the header repeats', async () => {
  const { claims, keyId } = await setup()
  const forger = await keyPair()
  const current = Math.floor(Date.now() / 1_000)
  const forged = await Attestation.sign(
    { ...claims, exp: current + 600, iat: current },
    { key: forger.privateKey, keyId },
  )
  let lookups = 0
  const verifier = Attestation.Server.verifier({
    audience,
    issuer,
    keyResolver: () => {
      lookups++
      return undefined
    },
    type: 'email',
  })
  const request = new Request(audience, {
    headers: { [Attestation.Constants.header]: Array(50).fill(forged).join(', ') },
  })
  expect(await verifier.verify(request, {} as Parameters<typeof verifier.verify>[1])).toMatchObject(
    { status: 'invalid', code: 401 },
  )
  expect(lookups).toBe(1)
})

test('accepts a valid token behind a forged one with a later expiry', async () => {
  const { claims, keyId, keys } = await setup()
  const forger = await keyPair()
  const current = Math.floor(Date.now() / 1_000)
  const valid = await Attestation.sign(
    { ...claims, exp: current + 600, iat: current },
    { key: keys.privateKey, keyId },
  )
  const forged = await Attestation.sign(
    { ...claims, exp: current + 3_000, iat: current, sub: 'mallory@example.com' },
    { key: forger.privateKey, keyId },
  )
  const verifier = Attestation.Server.verifier({
    audience,
    issuer,
    keyResolver: ({ keyId: kid }) => (kid === keyId ? keys.publicKey : undefined),
    type: 'email',
  })
  const request = new Request(audience, {
    headers: { [Attestation.Constants.header]: forged + ', ' + valid },
  })
  expect(await verifier.verify(request, {} as Parameters<typeof verifier.verify>[1])).toMatchObject(
    { status: 'valid', value: { claims: { sub: 'dana@example.com' } } },
  )
})

test('accepts a valid token behind one whose key cannot be resolved', async () => {
  const { claims, keyId, keys } = await setup()
  const current = Math.floor(Date.now() / 1_000)
  const valid = await Attestation.sign(
    { ...claims, exp: current + 600, iat: current },
    { key: keys.privateKey, keyId },
  )
  const forged = await Attestation.sign(
    { ...claims, exp: current + 3_000, iat: current, sub: 'mallory@example.com' },
    { key: (await keyPair()).privateKey, keyId: 'unknown' },
  )
  const verifier = Attestation.Server.verifier({
    audience,
    issuer,
    keyResolver: ({ keyId: kid }) => {
      if (kid !== keyId) throw new Error('down')
      return keys.publicKey
    },
    type: 'email',
  })
  const verify = (header: string) =>
    verifier.verify(
      new Request(audience, { headers: { [Attestation.Constants.header]: header } }),
      {} as Parameters<typeof verifier.verify>[1],
    )
  expect(await verify(forged + ', ' + valid)).toMatchObject({ status: 'valid' })
  expect(await verify(forged)).toMatchObject({ status: 'invalid', code: 503 })
})

test('reports an outage for a rotated-in key while the issuer is down', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let up = true
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      if (!up) throw new Error('down')
      return Response.json({ keys: [{ ...jwk, kid: keyId }] })
    },
    refreshInterval: 0,
    ttl: 0,
  })
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  up = false
  await new Promise((resolve) => setTimeout(resolve, 5))
  // The known key keeps working from the last good set; a new one is an outage, not unknown.
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  await expect(keyResolver({ issuer, keyId: 'rotated' })).rejects.toThrow('down')
})

test('rejects a plaintext http issuer except on localhost', () => {
  const config = { audience, keyResolver: () => undefined, type: 'email' }
  expect(() => Attestation.Server.verifier({ ...config, issuer: 'http://issuer.example' })).toThrow(
    'https',
  )
  expect(() =>
    Attestation.Server.verifier({ ...config, issuer: 'http://localhost:8787' }),
  ).not.toThrow()
})

test('rejects a non-finite clock tolerance or max age', () => {
  const config = { audience, issuer, keyResolver: () => undefined, type: 'email' }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1])
    expect(() => Attestation.Server.verifier({ ...config, clockTolerance: value })).toThrow(
      'non-negative integer',
    )
  expect(() => Attestation.Server.verifier({ ...config, maxAge: Number.NaN })).toThrow(
    'non-negative integer',
  )
})

test('answers 503 while the issuer keys are unreachable', async () => {
  const { claims, keyId, keys } = await setup()
  const current = Math.floor(Date.now() / 1_000)
  const token = await Attestation.sign(
    { ...claims, exp: current + 600, iat: current },
    { key: keys.privateKey, keyId },
  )
  const verifier = Attestation.Server.verifier({
    audience,
    issuer,
    keyResolver: () => {
      throw new Error('down')
    },
    type: 'email',
  })
  const request = new Request(audience, { headers: { [Attestation.Constants.header]: token } })
  const result = await verifier.verify(request, {} as Parameters<typeof verifier.verify>[1])
  expect(result).toMatchObject({ status: 'invalid', code: 503 })
  expect(result).not.toHaveProperty('headers')
})

test('fetches the key set with the unwrapped fetch, so it never pays a 402', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const calls: string[] = []
  const inner = (async () => {
    calls.push('inner')
    return Response.json({ keys: [{ ...jwk, kid: keyId }] })
  }) as typeof globalThis.fetch
  const wrapper = Object.assign(
    (async () => {
      calls.push('wrapper')
      return new Response(null, { status: 402 })
    }) as typeof globalThis.fetch,
    { [Symbol.for('mppx.fetch.wrapper')]: inner },
  )
  const keyResolver = Attestation.Jwks.resolver({ fetch: wrapper })
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  expect(calls).toEqual(['inner'])
})

test('skips keys the issuer restricts to other uses', async () => {
  const { keyId, keys } = await setup()
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const keyResolver = Attestation.Jwks.resolver({
    async fetch() {
      return Response.json({
        keys: [
          { ...jwk, kid: 'enc', use: 'enc' },
          { ...jwk, kid: 'rs', alg: 'RS256' },
          { ...jwk, kid: 'ops', key_ops: ['encrypt'] },
          { ...jwk, kid: keyId, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] },
        ],
      })
    },
  })
  expect(await keyResolver({ issuer, keyId })).toBeDefined()
  for (const kid of ['enc', 'rs', 'ops'])
    expect(await keyResolver({ issuer, keyId: kid })).toBeUndefined()
})

test('accepts an audience configured with a trailing slash', async () => {
  const { claims, keyId, keys } = await setup()
  const current = Math.floor(Date.now() / 1_000)
  const token = await Attestation.sign(
    { ...claims, exp: current + 600, iat: current },
    { key: keys.privateKey, keyId },
  )
  const verifier = Attestation.Server.verifier({
    audience: `${audience}/`,
    issuer,
    keyResolver: ({ keyId: kid }) => (kid === keyId ? keys.publicKey : undefined),
    type: 'email',
  })
  const request = new Request(audience, { headers: { [Attestation.Constants.header]: token } })
  expect(await verifier.verify(request, {} as Parameters<typeof verifier.verify>[1])).toMatchObject(
    { status: 'valid' },
  )
})

test('never attaches an attestation over plaintext http', async () => {
  const { claims, keyId, keys } = await setup()
  const current = Math.floor(Date.now() / 1_000)
  const token = await Attestation.sign(
    { ...claims, aud: 'http://api.example', exp: current + 600, iat: current },
    { key: keys.privateKey, keyId },
  )
  const prover = Attestation.Client.prover({ attestations: [token], scope: '*' })
  const request = await prover.prove(
    new Request('http://api.example/resource'),
    {} as Parameters<typeof prover.prove>[1],
  )
  expect(request.headers.get(Attestation.Constants.header)).toBeNull()
})
