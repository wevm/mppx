import type { RequestListener } from 'node:http'

import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as World from 'mppx/extensions/identity/world'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { Base64 } from 'ox'
import { afterEach, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

const issuer = 'https://idp.example'
const clientId = 'client-1'
const config = {
  clientId,
  clientSecret: 's3cret/+',
  issuer,
  secretKey: 'test-secret-key-test-secret-key-32',
}

const keyPair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)
const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

const b64 = (value: unknown) => Base64.fromString(JSON.stringify(value), { pad: false, url: true })

/** Signs an ID token as World IdP would, with overrides for the claims or header. */
async function idToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header })}.${b64({
    iss: issuer,
    sub: 'human-1',
    aud: clientId,
    exp: now + 300,
    iat: now,
    jti: 'j1',
    auth_time: now,
    acr: World.Constants.acr.orb,
    amr: ['pop'],
    ...claims,
  })}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
}

/**
 * A fake World IdP: the token endpoint answers each of `polls` (an OAuth error, or `503`) in
 * turn, then an ID token from `token`.
 */
function idp(options: { polls?: string[]; token?: () => Promise<string>; down?: boolean } = {}) {
  const polls = [...(options.polls ?? [])]
  const calls: { path: string; form: URLSearchParams; authorization: string | null }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.down) throw new TypeError('fetch failed')
    const request = new Request(input, init)
    const { pathname } = new URL(request.url)
    if (pathname === '/.well-known/openid-configuration')
      return Response.json({
        issuer,
        device_authorization_endpoint: `${issuer}/device_authorization`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
      })
    if (pathname === '/jwks.json')
      return Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] })
    const form = new URLSearchParams(await request.text())
    calls.push({ path: pathname, form, authorization: request.headers.get('authorization') })
    if (pathname === '/device_authorization')
      return Response.json({
        device_code: 'device-code-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: `${issuer}/device`,
        verification_uri_complete: `${issuer}/device?user_code=ABCD-EFGH`,
        expires_in: 1200,
        interval: 1,
      })
    const next = polls.shift()
    if (next === '503') return new Response('down', { status: 503 })
    if (next) return Response.json({ error: next }, { status: 400 })
    return Response.json({
      id_token: await (options.token ?? idToken)(),
      access_token: 'access',
      token_type: 'Bearer',
      expires_in: 300,
    })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

function device(result: { headers?: HeadersInit | undefined }): World.Device {
  return JSON.parse(Base64.toString(new Headers(result.headers).get(World.Constants.deviceHeader)!))
}

const poll = (value: string) =>
  new Request('https://api.example/report', { headers: { 'World-Id-Poll': value } })

afterEach(() => {
  vi.useRealTimers()
})

/** Moves the clock forward, as a client waiting between polls does. */
function wait(seconds: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + seconds * 1000)
}

/** Starts an attempt and polls it at its interval until it settles; returns every result. */
async function run(verifier: ReturnType<typeof World.Server.verifier>) {
  const results = [await verifier.verify(poll('start'))]
  let state = device(results[0] as never)
  while (state.status === 'pending') {
    wait(state.interval)
    const result = await verifier.verify(poll(state.attempt))
    results.push(result)
    state = device(result as never)
  }
  return { results, state }
}

test('asks for World ID when the request has no session', async () => {
  const verifier = World.Server.verifier({ ...config, fetch: idp().fetch })
  const result = await verifier.verify(new Request('https://api.example/report'))
  expect(result).toMatchObject({ status: 'missing' })
  expect(new Headers((result as { headers: HeadersInit }).headers).get('World-Id-Required')).toBe(
    'device',
  )
})

test('runs the device flow and accepts the session it issues', async () => {
  const world = idp({ polls: ['authorization_pending'] })
  const verifier = World.Server.verifier({ ...config, fetch: world.fetch })
  const { results, state } = await run(verifier)

  const started = device(results[0] as never)
  expect(started).toMatchObject({
    status: 'pending',
    user_code: 'ABCD-EFGH',
    verification_uri_complete: `${issuer}/device?user_code=ABCD-EFGH`,
    interval: 1,
  })
  // A device-flow call never verifies, and the device code never leaves the server.
  for (const result of results) {
    expect(result.status).toBe('missing')
    expect(JSON.stringify(result)).not.toContain('device-code-secret')
  }
  expect(results).toHaveLength(3)
  expect(state.status).toBe('approved')

  // Client authentication is HTTP Basic with form-encoded credentials, and acr is essential.
  expect(world.calls[0]!.authorization).toBe(`Basic ${btoa('client-1:s3cret%2F%2B')}`)
  expect(world.calls[0]!.form.get('scope')).toBe('openid')
  expect(JSON.parse(world.calls[0]!.form.get('claims')!)).toEqual({
    id_token: {
      acr: { essential: true, values: [World.Constants.acr.orb, World.Constants.acr.orbFace] },
    },
  })
  expect(world.calls[1]!.form.get('device_code')).toBe('device-code-secret')

  const session = (state as { session: string }).session
  const result = await verifier.verify(
    new Request('https://api.example/report', { headers: { 'World-Id': session } }),
  )
  expect(result).toMatchObject({
    status: 'valid',
    value: { issuer, subject: 'human-1', acr: World.Constants.acr.orb, amr: ['pop'] },
  })

  // A session sealed for another client, or tampered with, is not accepted.
  const other = World.Server.verifier({ ...config, clientId: 'client-2', fetch: world.fetch })
  for (const [check, token] of [
    [other, session],
    [verifier, `${session.slice(0, -2)}AA`],
    [verifier, 'not a token'],
  ] as const)
    expect(
      await check.verify(new Request('https://api.example', { headers: { 'World-Id': token } })),
    ).toMatchObject({ status: 'invalid' })
  // An attempt token is not a session, and a session is not an attempt.
  const attempt = (started as { attempt: string }).attempt
  expect(
    await verifier.verify(new Request('https://api.example', { headers: { 'World-Id': attempt } })),
  ).toMatchObject({ status: 'invalid' })
  expect(device((await verifier.verify(poll(session))) as never)).toEqual({ status: 'expired' })
})

test('polls World IdP at most once per interval', async () => {
  const world = idp({ polls: ['authorization_pending'] })
  const verifier = World.Server.verifier({ ...config, fetch: world.fetch })
  const started = device((await verifier.verify(poll('start'))) as never) as { attempt: string }
  // Too early: answered pending without calling World IdP.
  const early = device((await verifier.verify(poll(started.attempt))) as never)
  expect(early).toMatchObject({ status: 'pending', interval: 1 })
  expect(world.calls.filter((call) => call.path === '/token')).toHaveLength(0)
  wait(1)
  const pending = device((await verifier.verify(poll(started.attempt))) as never) as {
    attempt: string
  }
  expect(world.calls.filter((call) => call.path === '/token')).toHaveLength(1)
  // Polling again at once waits, with either token: the verifier holds the schedule.
  await verifier.verify(poll(pending.attempt))
  await verifier.verify(poll(started.attempt))
  expect(world.calls.filter((call) => call.path === '/token')).toHaveLength(1)
})

test('keeps slow_down when an older attempt token is replayed', async () => {
  const world = idp({ polls: ['slow_down', 'authorization_pending'] })
  const verifier = World.Server.verifier({ ...config, fetch: world.fetch })
  const started = device((await verifier.verify(poll('start'))) as never) as { attempt: string }
  wait(1)
  expect(device((await verifier.verify(poll(started.attempt))) as never)).toMatchObject({
    interval: 6,
  })
  // The first token still says 1 second, but the verifier holds the slower schedule.
  wait(1)
  await verifier.verify(poll(started.attempt))
  expect(world.calls.filter((call) => call.path === '/token')).toHaveLength(1)
  wait(5)
  await verifier.verify(poll(started.attempt))
  expect(world.calls.filter((call) => call.path === '/token')).toHaveLength(2)
})

test('slows down, and ends denied or expired attempts', async () => {
  const slow = World.Server.verifier({ ...config, fetch: idp({ polls: ['slow_down'] }).fetch })
  const { results } = await run(slow)
  expect(device(results[1] as never)).toMatchObject({ status: 'pending', interval: 6 })

  for (const [error, status] of [
    ['access_denied', 'denied'],
    ['invalid_grant', 'denied'],
    ['expired_token', 'expired'],
  ] as const) {
    const verifier = World.Server.verifier({ ...config, fetch: idp({ polls: [error] }).fetch })
    const { results, state } = await run(verifier)
    expect(state).toEqual({ status })
    expect(results.at(-1)).toMatchObject({ status: 'invalid' })
  }
})

test('validates the ID token', async () => {
  const now = Math.floor(Date.now() / 1000)
  const cases: [string, () => Promise<string>][] = [
    ['issuer', () => idToken({ iss: 'https://evil.example' })],
    ['audience', () => idToken({ aud: 'client-2' })],
    ['audiences without azp', () => idToken({ aud: [clientId, 'client-2'] })],
    ['expired', () => idToken({ exp: now - 120 })],
    ['future iat', () => idToken({ iat: now + 600 })],
    ['old authentication', () => idToken({ auth_time: now - 600 })],
    ['selfie class', () => idToken({ acr: World.Constants.acr.selfie })],
    ['no class', () => idToken({ acr: undefined })],
    ['no amr', () => idToken({ amr: undefined })],
    ['algorithm', () => idToken({}, { alg: 'none' })],
    ['unknown key', () => idToken({}, { kid: 'k2' })],
    ['signature', async () => `${(await idToken()).slice(0, -4)}AAAA`],
  ]
  for (const [name, token] of cases) {
    const verifier = World.Server.verifier({ ...config, fetch: idp({ token }).fetch })
    const { state } = await run(verifier)
    expect(state, name).toEqual({ status: 'denied' })
  }

  // A route that accepts Selfie Check gets it.
  const selfie = World.Server.verifier({
    ...config,
    acr: [World.Constants.acr.selfie],
    fetch: idp({ token: () => idToken({ acr: World.Constants.acr.selfie }) }).fetch,
  })
  const { state } = await run(selfie)
  expect(state.status).toBe('approved')
  // A Selfie Check session does not pass a verifier that accepts only Orb.
  const orb = World.Server.verifier({ ...config, fetch: idp().fetch })
  const session = (state as { session: string }).session
  expect(
    await orb.verify(new Request('https://api.example', { headers: { 'World-Id': session } })),
  ).toMatchObject({ status: 'invalid' })
})

test('maps World IdP outages to unavailable, never to approval', async () => {
  const down = World.Server.verifier({ ...config, fetch: idp({ down: true }).fetch })
  expect(await down.verify(poll('start'))).toMatchObject({ status: 'unavailable' })

  const flaky = World.Server.verifier({ ...config, fetch: idp({ polls: ['503'] }).fetch })
  const started = device((await flaky.verify(poll('start'))) as never)
  wait(1)
  expect(await flaky.verify(poll((started as { attempt: string }).attempt))).toMatchObject({
    status: 'unavailable',
  })

  const misconfigured = World.Server.verifier({
    ...config,
    fetch: idp({ polls: ['invalid_client'] }).fetch,
  })
  const attempt = device((await misconfigured.verify(poll('start'))) as never)
  wait(1)
  expect(await misconfigured.verify(poll((attempt as { attempt: string }).attempt))).toMatchObject({
    status: 'unavailable',
  })
})

test('sends client_secret_post credentials in the form', async () => {
  const world = idp()
  const verifier = World.Server.verifier({
    ...config,
    clientAuthentication: 'client_secret_post',
    fetch: world.fetch,
  })
  await verifier.verify(poll('start'))
  expect(world.calls[0]!.authorization).toBeNull()
  expect(world.calls[0]!.form.get('client_id')).toBe(clientId)
  expect(world.calls[0]!.form.get('client_secret')).toBe('s3cret/+')
})

test('rejects bad configuration', () => {
  expect(() => World.Server.verifier({ ...config, secretKey: '' })).toThrow(TypeError)
  expect(() => World.Server.verifier({ ...config, acr: [] })).toThrow(TypeError)
  expect(() => World.Server.verifier({ ...config, issuer: 'http://idp.example' })).toThrow(
    TypeError,
  )
  expect(() => World.Server.verifier({ ...config, sessionTtl: Number.NaN })).toThrow(TypeError)
})

test('runs the full client flow: approval, then the paid retry carries the session', async () => {
  const testMethod = Method.from({
    name: 'test',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
    },
  })
  const serverMethod = Method.toServer(testMethod, {
    async verify() {
      return Receipt.from({
        method: 'test',
        reference: 'r',
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
  const clientMethod = Method.toClient(testMethod, {
    async createCredential({ challenge }) {
      return Credential.serialize({ challenge, payload: { token: 'paid' } })
    },
  })
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const world = idp({ polls: ['authorization_pending'] })
  const human = World.Server.verifier({ ...config, fetch: world.fetch })
  let handled = 0
  const listener = ServerRequest.toNodeListener(async (request) => {
    const result = await mppx.charge({
      amount: '1',
      currency: 'USD',
      recipient: 'merchant',
      identity: [human],
    })(request)
    if (result.status === 402) return result.challenge
    handled++
    return result.withReceipt(new Response(result.identity?.get(human)?.subject))
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)

  try {
    const shown: { url: string; userCode: string; origin: string }[] = []
    const client = ClientMppx.create({
      identity: [
        World.Client.prover({
          scope: [server.url],
          verification: (parameters) => {
            shown.push(parameters)
          },
        }),
      ],
      methods: [clientMethod],
      polyfill: false,
    })
    const response = await client.fetch(`${server.url}/report`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('human-1')
    expect(handled).toBe(1)
    expect(shown).toEqual([
      {
        origin: new URL(server.url).origin,
        url: `${issuer}/device?user_code=ABCD-EFGH`,
        userCode: 'ABCD-EFGH',
        expiresAt: expect.any(Date),
      },
    ])

    // The session is reused: no new attempt.
    const again = await client.fetch(`${server.url}/report`)
    expect(again.status).toBe(200)
    expect(world.calls.filter((call) => call.path === '/device_authorization')).toHaveLength(1)

    // Aborting the request stops waiting for approval: no more polls.
    const controller = new AbortController()
    const aborting = ClientMppx.create({
      identity: [
        World.Client.prover({ scope: [server.url], verification: () => controller.abort() }),
      ],
      methods: [clientMethod],
      polyfill: false,
    })
    const polls = world.calls.length
    await expect(
      aborting.fetch(`${server.url}/report`, { signal: controller.signal }),
    ).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(world.calls.length).toBe(polls + 1)

    // Declining the link leaves the request rejected.
    const declining = ClientMppx.create({
      identity: [World.Client.prover({ scope: [server.url], verification: () => false })],
      methods: [clientMethod],
      polyfill: false,
    })
    expect((await declining.fetch(`${server.url}/report`)).status).toBe(401)

    // Out of scope: the route asks for World ID and nothing starts.
    const anonymous = ClientMppx.create({
      identity: [
        World.Client.prover({ scope: ['https://elsewhere.example'], verification: () => {} }),
      ],
      methods: [clientMethod],
      polyfill: false,
    })
    expect((await anonymous.fetch(server.url)).status).toBe(401)
    expect(handled).toBe(2)
  } finally {
    server.close()
  }
})
