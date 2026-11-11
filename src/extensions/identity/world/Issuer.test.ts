import type { RequestListener } from 'node:http'

import { Mppx as ClientMppx } from 'mppx/client'
import * as Attestation from 'mppx/extensions/identity/attestation'
import * as World from 'mppx/extensions/identity/world'
import * as Identity from 'mppx/identity'
import { Request as ServerRequest, Store } from 'mppx/server'
import { Base64 } from 'ox'
import { afterEach, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'
import { keyPair } from '~test/Identity.js'

const worldIssuer = 'https://auth.world.example'
const clientId = 'app_test'

type Answer = 'approve' | 'pending' | 'slow_down' | 'access_denied' | 503

/**
 * An in-process World IdP: discovery, device authorization, token and JWKS. Each token poll
 * answers with the next entry of `answers`, then approves; `jwksDown` fails that many JWKS fetches.
 */
async function createWorld(options: { answers?: Answer[]; jwksDown?: number; acr?: string } = {}) {
  const keys = (await crypto.subtle.generateKey(
    {
      hash: 'SHA-256',
      modulusLength: 2_048,
      name: 'RSASSA-PKCS1-v1_5',
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const answers = [...(options.answers ?? [])]
  let jwksDown = options.jwksDown ?? 0
  let kid = 'k1'
  const calls: string[] = []
  let started = 0
  const encode = (value: unknown) =>
    Base64.fromString(JSON.stringify(value), { pad: false, url: true })
  async function idToken(sub: string) {
    const now = Math.floor(Date.now() / 1_000)
    const input = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({
      acr: options.acr ?? World.Constants.acr.orb,
      amr: ['pop'],
      aud: clientId,
      auth_time: now,
      exp: now + 300,
      iat: now,
      iss: worldIssuer,
      sub,
    })}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keys.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const { origin, pathname } = new URL(request.url)
    if (origin !== worldIssuer) throw new Error(`Unexpected fetch to ${origin}`)
    calls.push(pathname)
    if (pathname === '/.well-known/openid-configuration')
      return Response.json({
        device_authorization_endpoint: `${worldIssuer}/device`,
        issuer: worldIssuer,
        jwks_uri: `${worldIssuer}/jwks`,
        token_endpoint: `${worldIssuer}/token`,
      })
    if (pathname === '/jwks') {
      if (jwksDown > 0) {
        jwksDown--
        return new Response(null, { status: 503 })
      }
      const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
      return Response.json({
        keys: [{ alg: 'RS256', e: jwk.e, kid, kty: 'RSA', n: jwk.n, use: 'sig' }],
      })
    }
    if (pathname === '/device') {
      started++
      return Response.json({
        device_code: `device-${started}`,
        expires_in: 600,
        interval: 1,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://world.example/device',
        verification_uri_complete: 'https://world.example/device?code=ABCD-EFGH',
      })
    }
    if (pathname === '/token') {
      const answer = answers.shift() ?? 'approve'
      if (answer === 503) return new Response(null, { status: 503 })
      if (answer === 'approve') return Response.json({ id_token: await idToken('world-human-1') })
      return Response.json(
        { error: answer === 'pending' ? 'authorization_pending' : answer },
        { status: 400 },
      )
    }
    return new Response('Not found', { status: 404 })
  }
  return {
    calls,
    failJwks(count: number) {
      jwksDown = count
    },
    fetch,
    rotate(next: string) {
      kid = next
    },
  }
}

async function createIssuer(
  world: { fetch: typeof globalThis.fetch },
  options: Partial<World.Issuer.create.Config> = {},
) {
  return World.Issuer.create({
    clientId,
    clientSecret: 'secret',
    fetch: world.fetch,
    secretKey: 'test-secret-key-test-secret-key-32',
    signingKey: await keyPair(),
    store: Store.memory(),
    url: 'https://world-id.issuer.example',
    worldIssuer,
    ...options,
  })
}

function post(issuer: World.Issuer.Issuer, path: string, body: unknown, headers = {}) {
  return issuer.handle(
    new Request(`${issuer.url}${path}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
    }),
  ) as Promise<Response>
}

afterEach(() => {
  vi.useRealTimers()
})

/** Starts an attempt and moves the clock past its first interval. */
async function start(issuer: World.Issuer.Issuer, audience = 'https://api.example') {
  vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
  const response = await post(issuer, World.Constants.devicePath, { audience })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { id: string; interval: number }
  vi.setSystemTime(Date.now() + body.interval * 1_000)
  return body
}

async function poll(issuer: World.Issuer.Issuer, id: string) {
  const response = await post(issuer, World.Constants.tokenPath, { id })
  return { body: (await response.json()) as Record<string, string>, status: response.status }
}

test('runs the device flow and signs a pairwise attestation a networked verifier accepts', async () => {
  const world = await createWorld({ answers: ['pending'] })
  const issuer = await createIssuer(world)
  const device = await start(issuer)
  expect((await poll(issuer, device.id)).body.error).toBe('authorization_pending')
  vi.setSystemTime(Date.now() + 1_000)
  const approved = await poll(issuer, device.id)
  expect(approved.status).toBe(200)
  const claims = Attestation.decode(approved.body.attestation!)!.claims as Record<string, unknown>
  expect(claims).toMatchObject({
    acr: World.Constants.acr.orb,
    aud: 'https://api.example',
    iss: issuer.url,
    type: 'world-id',
  })
  // Pairwise: not World's subject.
  expect(claims.sub).not.toBe('world-human-1')
  vi.useRealTimers()

  // A networked verifier reads the key from the issuer's JWKS route.
  const verifier = World.Server.verifier({
    audience: 'https://api.example',
    fetch: async (input, init) => (await issuer.handle(new Request(input, init)))!,
    issuer: issuer.url,
  })
  const result = await verifier.verify(
    new Request('https://api.example/report', {
      headers: { [Attestation.Constants.header]: approved.body.attestation! },
    }),
  )
  expect(result).toMatchObject({
    status: 'valid',
    value: { issuer: issuer.url, subject: claims.sub },
  })
})

test('derives a different subject per audience', async () => {
  const world = await createWorld()
  const issuer = await createIssuer(world)
  const subjects = []
  for (const audience of ['https://a.example', 'https://b.example']) {
    const device = await start(issuer, audience)
    const { body } = await poll(issuer, device.id)
    subjects.push(Attestation.decode(body.attestation!)!.claims.sub)
  }
  expect(subjects[0]).not.toBe(subjects[1])
})

test('keeps an approval through a World IdP key outage', async () => {
  const world = await createWorld({ jwksDown: 1 })
  const issuer = await createIssuer(world)
  const device = await start(issuer)
  expect((await poll(issuer, device.id)).status).toBe(503)
  vi.setSystemTime(Date.now() + 1_000)
  expect((await poll(issuer, device.id)).status).toBe(200)
  // The device code was redeemed once; the second poll only verified the kept ID token.
  expect(world.calls.filter((path) => path === '/token')).toHaveLength(1)
})

test('keeps an approval when World IdP rotated its key during a JWKS outage', async () => {
  const world = await createWorld()
  const issuer = await createIssuer(world)
  // The first approval caches World IdP's keys.
  let device = await start(issuer)
  expect((await poll(issuer, device.id)).status).toBe(200)
  // Past the cache's lifetime, World IdP signs with a new key while its JWKS is down.
  vi.setSystemTime(Date.now() + 360_000)
  world.rotate('k2')
  world.failJwks(1)
  device = await start(issuer)
  expect((await poll(issuer, device.id)).status).toBe(503)
  vi.setSystemTime(Date.now() + 1_000)
  expect((await poll(issuer, device.id)).status).toBe(200)
})

test('answers a completed attempt again, so a lost response keeps the approval', async () => {
  const world = await createWorld()
  const issuer = await createIssuer(world)
  const device = await start(issuer)
  const first = await poll(issuer, device.id)
  expect(first.status).toBe(200)
  const again = await poll(issuer, device.id)
  expect(again).toEqual(first)
  expect(world.calls.filter((path) => path === '/token')).toHaveLength(1)
})

test('polls World IdP at most once per interval', async () => {
  const world = await createWorld({ answers: ['pending', 'slow_down'] })
  const issuer = await createIssuer(world)
  const device = await start(issuer)
  expect((await poll(issuer, device.id)).body.error).toBe('authorization_pending')
  // Polled again at once: answered without calling World IdP.
  expect((await poll(issuer, device.id)).body.error).toBe('slow_down')
  vi.setSystemTime(Date.now() + 1_000)
  expect((await poll(issuer, device.id)).body.error).toBe('slow_down')
  // slow_down raised the interval to 6 s.
  vi.setSystemTime(Date.now() + 5_000)
  expect((await poll(issuer, device.id)).body.error).toBe('slow_down')
  vi.setSystemTime(Date.now() + 1_000)
  expect((await poll(issuer, device.id)).status).toBe(200)
  expect(world.calls.filter((path) => path === '/token')).toHaveLength(3)
})

test('ends a denied attempt, and an outage is unavailable', async () => {
  const world = await createWorld({ answers: [503, 'access_denied'] })
  const issuer = await createIssuer(world)
  const device = await start(issuer)
  expect((await poll(issuer, device.id)).status).toBe(503)
  vi.setSystemTime(Date.now() + 1_000)
  expect((await poll(issuer, device.id)).body.error).toBe('access_denied')
  vi.setSystemTime(Date.now() + 1_000)
  expect((await poll(issuer, device.id)).body.error).toBe('expired_token')
})

test('authorize, audiences and limit decide who may start an attempt', async () => {
  const world = await createWorld()
  const issuer = await createIssuer(world, {
    audiences: ['https://api.example'],
    authorize: (request) => request.headers.get('x-api-key') === 'k',
    limit: { key: (request) => request.headers.get('x-api-key') ?? undefined, max: 1, window: 60 },
  })
  const audience = 'https://api.example'
  expect((await post(issuer, World.Constants.devicePath, { audience })).status).toBe(403)
  expect(
    (
      await post(
        issuer,
        World.Constants.devicePath,
        { audience: 'https://other.example' },
        { 'x-api-key': 'k' },
      )
    ).status,
  ).toBe(403)
  expect(
    (await post(issuer, World.Constants.devicePath, { audience }, { 'x-api-key': 'k' })).status,
  ).toBe(200)
  const limited = await post(issuer, World.Constants.devicePath, { audience }, { 'x-api-key': 'k' })
  expect(limited.status).toBe(429)
  expect(limited.headers.get('retry-after')).toBe('60')
  expect(world.calls.filter((path) => path === '/device')).toHaveLength(1)
})

test('leaves other requests to the app', async () => {
  const issuer = await createIssuer(await createWorld())
  expect(await issuer.handle(new Request(`${issuer.url}/api/report`))).toBeUndefined()
  expect(
    (await issuer.handle(new Request(`${issuer.url}${World.Constants.devicePath}`)))!.status,
  ).toBe(405)
  const jwks = (await (await issuer.handle(
    new Request(`${issuer.url}/.well-known/jwks.json`),
  ))!.json()) as {
    keys: { alg: string }[]
  }
  expect(jwks.keys.map(({ alg }) => alg)).toEqual(['EdDSA'])
})

test('reads at most 4 KiB of a body, even without a content length', async () => {
  const issuer = await createIssuer(await createWorld())
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      controller.enqueue(new Uint8Array(1_024).fill(32))
    },
  })
  const response = (await issuer.handle(
    new Request(`${issuer.url}${World.Constants.devicePath}`, {
      body,
      duplex: 'half',
      method: 'POST',
    } as RequestInit),
  ))!
  expect(response.status).toBe(400)
  expect(pulled).toBeLessThan(10)
})

test('fails a start it cannot index for cleanup, and saves nothing', async () => {
  const memory = Store.memory()
  let failing = true
  const store: typeof memory = {
    ...memory,
    update(key, change) {
      if (failing && key.includes(':expiry:')) return Promise.reject(new Error('store down'))
      return memory.update(key, change)
    },
  }
  const world = await createWorld()
  const issuer = await createIssuer(world, {
    limit: { key: () => 'all', max: 5, window: 60 },
    store,
  })
  const response = await post(issuer, World.Constants.devicePath, {
    audience: 'https://api.example',
  })
  expect(response.status).toBe(503)
  expect(await memory.get(`mppx:world-id:${issuer.url}:limit:all`)).toBeNull()
  failing = false
  expect(
    (await post(issuer, World.Constants.devicePath, { audience: 'https://api.example' })).status,
  ).toBe(200)
})

test('deletes abandoned attempts and ended limit windows', async () => {
  const world = await createWorld()
  const store = Store.memory()
  const issuer = await createIssuer(world, {
    limit: { key: (request) => request.headers.get('x-caller') ?? undefined, max: 5, window: 60 },
    store,
  })
  vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
  const response = await post(
    issuer,
    World.Constants.devicePath,
    { audience: 'https://api.example' },
    { 'x-caller': 'a' },
  )
  const { id } = (await response.json()) as { id: string }
  expect(await store.get(`mppx:world-id:${issuer.url}:attempt:${id}`)).not.toBeNull()
  expect(await store.get(`mppx:world-id:${issuer.url}:limit:a`)).not.toBeNull()

  // Within two minutes after the attempt's 600 s expiry, another caller's start sweeps both.
  vi.setSystemTime(Date.now() + 722_000)
  for (let i = 0; i < 2; i++)
    await post(
      issuer,
      World.Constants.devicePath,
      { audience: 'https://api.example' },
      { 'x-caller': 'b' },
    )
  expect(await store.get(`mppx:world-id:${issuer.url}:attempt:${id}`)).toBeNull()
  expect(await store.get(`mppx:world-id:${issuer.url}:limit:a`)).toBeNull()
  expect(await store.get(`mppx:world-id:${issuer.url}:limit:b`)).not.toBeNull()
})

test("issuers sharing a store never redeem each other's attempts", async () => {
  const world = await createWorld()
  const store = Store.memory()
  const a = await createIssuer(world, { store })
  const b = await createIssuer(world, { store, url: 'https://other-issuer.example' })
  const device = await start(a)
  expect((await poll(b, device.id)).body.error).toBe('expired_token')
  expect((await poll(a, device.id)).status).toBe(200)
})

const servers: { close(): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

test('self-hosted: the app runs the issuer and the client gets approval through it', async () => {
  const world = await createWorld()
  let issuer: World.Issuer.Issuer | undefined
  let human: ReturnType<typeof World.Server.verifier> | undefined
  const listener = ServerRequest.toNodeListener(async (request) => {
    const answered = await issuer!.handle(request)
    if (answered) return answered
    const identity = await human!.verify(request)
    if (identity.status !== 'valid')
      return new Response(identity.reason, {
        ...(identity.headers && { headers: identity.headers }),
        status: Identity.Status.codes[identity.status],
      })
    return Response.json({ subject: identity.value.subject })
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)
  const origin = new URL(server.url).origin
  issuer = await createIssuer(world, { audiences: [origin], url: origin })
  human = World.Server.verifier({
    audience: origin,
    issuer: origin,
    keyResolver: issuer.keyResolver,
  })

  const shown: string[] = []
  const client = ClientMppx.create({
    identity: [
      World.Client.prover({
        issuers: [origin],
        scope: [origin],
        verification: ({ userCode }) => {
          shown.push(userCode)
        },
      }),
    ],
    methods: [],
    polyfill: false,
  })
  const response = await client.fetch(`${origin}/api/report`)
  expect(response.status).toBe(200)
  expect(shown).toEqual(['ABCD-EFGH'])
}, 10_000)
