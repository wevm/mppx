import { Credential, Method, Receipt, Store, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Attestation from 'mppx/extensions/identity/attestation'
import * as TempoId from 'mppx/extensions/identity/tempo'
import * as Identity from 'mppx/identity'
import { Mppx } from 'mppx/server'
import { Base64 } from 'ox'
import { expect, test } from 'vp/test'
import { keyPair } from '~test/Identity.js'

const tempoIdOrigin = 'https://id.tempo.xyz'
const clientId = 'app_test'
const attestUrl = 'https://attest.example'
const origin = 'https://api.example'
const url = `${origin}/haiku`

const method = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
  },
})
const clientMethod = Method.toClient(method, {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'paid' } })
  },
})
const serverMethod = Method.toServer(method, {
  async verify() {
    return Receipt.from({
      method: 'test',
      reference: 'ref',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
const charge = { amount: '1', currency: 'USD', recipient: 'merchant' } as const

const encode = (value: unknown) =>
  Base64.fromString(JSON.stringify(value), { pad: false, url: true })

/** A stand-in for Tempo ID: an RS256 key set, and access and ID tokens shaped like Tempo ID's. */
async function createTempoId() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    alg: 'RS256',
    kid: 'k1',
    use: 'sig',
  }
  const fetch = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`${tempoIdOrigin}/oauth2/jwks`)
    return Response.json({ keys: [jwk] })
  }) as typeof globalThis.fetch
  async function sign(header: Record<string, unknown>, claims: Record<string, unknown>) {
    const input = `${encode({ alg: 'RS256', kid: 'k1', ...header })}.${encode(claims)}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
  }
  const now = () => Math.floor(Date.now() / 1000)
  return {
    fetch,
    accessToken: (options: { aud?: string; dpop?: TempoId.DpopKey; sub?: string } = {}) =>
      (async () =>
        sign(
          { typ: 'at+jwt' },
          {
            access_keys: [],
            aud: options.aud ?? attestUrl,
            client_id: clientId,
            compliance: {},
            ...(options.dpop && { cnf: { jkt: await thumbprint(options.dpop.jwk) } }),
            exp: now() + 300,
            iat: now(),
            iss: tempoIdOrigin,
            sub: options.sub ?? 'user_01TEST',
          },
        ))(),
    idToken: (claims: Record<string, unknown> = {}) =>
      sign(
        { typ: 'JWT' },
        {
          aud: clientId,
          email: 'Ada@Example.com',
          email_verified: true,
          exp: now() + 300,
          iss: tempoIdOrigin,
          sub: 'user_01TEST',
          ...claims,
        },
      ),
  }
}

async function createDpop(): Promise<TempoId.DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    jwk: { crv: jwk.crv!, kty: jwk.kty!, x: jwk.x!, y: jwk.y! },
    privateKey: pair.privateKey,
  }
}

async function thumbprint(jwk: JsonWebKey) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Base64.fromBytes(new Uint8Array(digest), { pad: false, url: true })
}

/**
 * Tempo ID, a Tempo ID attestation issuer, and a merchant that requires `identity` built from
 * `Attestation.Server.verifier`s, behind one fetch that routes by origin.
 */
async function setup(
  identity: (keys: { fetch: typeof globalThis.fetch }) => Identity.Verifier[],
  config: Partial<TempoId.Issuer.create.Config> = {},
) {
  const tempoId = await createTempoId()
  const issuer = TempoId.Issuer.create({
    clientId,
    fetch: tempoId.fetch,
    signingKey: await keyPair(),
    store: Store.memory(),
    url: attestUrl,
    ...config,
  })
  const calls: string[] = []
  let merchant: (request: Request) => Promise<Response> = async () => new Response(null)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push(`${request.method} ${request.url}`)
    if (request.url.startsWith(attestUrl))
      return (await issuer.handle(request)) ?? new Response(null, { status: 404 })
    return merchant(request)
  }) as typeof globalThis.fetch
  const verifiers = identity({ fetch })
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'api.example',
    secretKey: 'test-secret-key-test-secret-key!',
  })
  merchant = async (request) => {
    const result = await mppx.charge({ ...charge, identity: verifiers })(request)
    if (result.status !== 200) return result.challenge
    return result.withReceipt(
      Response.json(verifiers.map((verifier) => result.identity?.get(verifier))),
    )
  }
  return { calls, fetch, issuer, tempoId }
}

test('a Tempo ID user gets tempo-id and email attestations from the issuer, then pays', async () => {
  const { calls, fetch, tempoId } = await setup(({ fetch }) => [
    Attestation.Server.verifier({ audience: origin, fetch, issuer: attestUrl, type: 'tempo-id' }),
    Attestation.Server.verifier({ audience: origin, fetch, issuer: attestUrl, type: 'email' }),
  ])
  const dpop = await createDpop()
  const accessToken = await tempoId.accessToken({ dpop })
  const idToken = await tempoId.idToken()
  const client = ClientMppx.create({
    fetch,
    identity: [
      TempoId.Client.attestations({
        accessToken: () => accessToken,
        dpop,
        fetch,
        idToken: () => idToken,
        issuer: attestUrl,
        scope: [origin],
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })

  const response = await client.fetch(url)
  expect(response.status).toBe(200)
  const [tempo, email] = (await response.json()) as { claims: Attestation.Claims }[]
  expect(tempo!.claims).toMatchObject({
    aud: origin,
    iss: attestUrl,
    sub: 'user_01TEST',
    azp: clientId,
    type: 'tempo-id',
    uid: 'user_01TEST',
  })
  expect(email!.claims).toMatchObject({
    aud: origin,
    iss: attestUrl,
    sub: 'ada@example.com',
    type: 'email',
    uid: 'user_01TEST',
  })
  // The access token went only to the issuer, never to the merchant.
  expect(calls.filter((call) => call.startsWith(`POST ${attestUrl}`))).toHaveLength(2)

  // Cached attestations are reused: no new exchange.
  expect((await client.fetch(url)).status).toBe(200)
  expect(calls.filter((call) => call.startsWith(`POST ${attestUrl}`))).toHaveLength(2)
})

test('a merchant accepts Tempo ID or another issuer with Identity.anyOf', async () => {
  const other = Attestation.Issuer.create({
    issuer: 'https://other-issuer.example',
    signingKey: await keyPair(),
  })
  const { fetch, tempoId } = await setup(({ fetch }) => [
    Identity.anyOf(
      Attestation.Server.verifier({
        audience: origin,
        issuer: other.issuer,
        keyResolver: other.keyResolver,
        type: 'email',
      }),
      Attestation.Server.verifier({ audience: origin, fetch, issuer: attestUrl, type: 'email' }),
    ),
  ])
  const unverified = await fetch(url)
  expect(unverified.status).toBe(401)
  expect(unverified.headers.get(Attestation.Constants.requiredHeader)).toBe(
    `(email;issuer="https://other-issuer.example" email;issuer="${attestUrl}")`,
  )
  const accessToken = await tempoId.accessToken()
  const idToken = await tempoId.idToken()
  const client = ClientMppx.create({
    fetch,
    identity: [
      TempoId.Client.attestations({
        accessToken: () => accessToken,
        fetch,
        idToken: () => idToken,
        issuer: attestUrl,
        scope: [origin],
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  expect((await client.fetch(url)).status).toBe(200)
})

test('refuses email without a verified address, and requests without a valid token', async () => {
  const { issuer, tempoId } = await setup(() => [])
  const post = (headers: Record<string, string>, body: unknown) =>
    issuer.handle(
      new Request(`${attestUrl}${TempoId.Constants.attestPath}`, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...headers },
        method: 'POST',
      }),
    )
  const accessToken = await tempoId.accessToken()
  const bearer = { Authorization: `Bearer ${accessToken}` }

  const unverified = await post(
    {
      ...bearer,
      [TempoId.Constants.idTokenHeader]: await tempoId.idToken({ email_verified: false }),
    },
    { audience: origin, type: 'email' },
  )
  expect(unverified!.status).toBe(403)
  expect((await post(bearer, { audience: origin, type: 'email' }))!.status).toBe(403)
  expect(
    await TempoId.Client.attest({
      accessToken: () => accessToken,
      audience: origin,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        (await issuer.handle(new Request(input, init)))!) as typeof globalThis.fetch,
      issuer: attestUrl,
      type: 'email',
    }),
  ).toBeUndefined()

  const missing = await post({}, { audience: origin, type: 'tempo-id' })
  expect(missing!.status).toBe(401)
  expect(missing!.headers.get('WWW-Authenticate')).toContain('DPoP')
  const forged = await post(
    { Authorization: 'Bearer a.b.c' },
    { audience: origin, type: 'tempo-id' },
  )
  expect(forged!.status).toBe(401)
  expect((await post(bearer, { audience: 'http://api.example', type: 'tempo-id' }))!.status).toBe(
    400,
  )
  expect((await post(bearer, { audience: origin, type: 'github' }))!.status).toBe(400)

  const ok = await post(bearer, { audience: origin, type: 'tempo-id' })
  expect(ok!.status).toBe(200)
  expect(ok!.headers.get('Access-Control-Allow-Origin')).toBe('*')
  const preflight = await issuer.handle(
    new Request(`${attestUrl}${TempoId.Constants.attestPath}`, { method: 'OPTIONS' }),
  )
  expect(preflight!.status).toBe(204)
  expect(preflight!.headers.get('Access-Control-Allow-Headers')).toContain('dpop')
})

test('a DPoP-bound token needs a proof for the issuer endpoint', async () => {
  const { issuer, tempoId } = await setup(() => [])
  const dpop = await createDpop()
  const accessToken = await tempoId.accessToken({ dpop })
  const response = await issuer.handle(
    new Request(`${attestUrl}${TempoId.Constants.attestPath}`, {
      body: JSON.stringify({ audience: origin, type: 'tempo-id' }),
      headers: { Authorization: `DPoP ${accessToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
    }),
  )
  expect(response!.status).toBe(401)
})

test('rejects a configuration it cannot serve', async () => {
  const signingKey = await keyPair()
  const store = Store.memory()
  expect(() =>
    TempoId.Issuer.create({ clientId, signingKey, store, url: 'http://attest.example' }),
  ).toThrow('https')
  expect(() =>
    TempoId.Issuer.create({
      clientId,
      signingKey,
      store,
      types: ['github' as never],
      url: attestUrl,
    }),
  ).toThrow('github')
  expect(() => TempoId.Issuer.create({ clientId: [], signingKey, store, url: attestUrl })).toThrow(
    'clientId',
  )
  expect(() =>
    TempoId.Issuer.create({ clientId, signingKey, store: undefined as never, url: attestUrl }),
  ).toThrow('store')
})

test('refuses a body over 4096 bytes before reading the token', async () => {
  const { issuer } = await setup(() => [])
  const response = await issuer.handle(
    new Request(`${attestUrl}${TempoId.Constants.attestPath}`, {
      body: JSON.stringify({ audience: origin, type: 'tempo-id', pad: 'x'.repeat(5_000) }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }),
  )
  expect(response!.status).toBe(400)
})

test('the client refuses a plaintext issuer', async () => {
  const options = { accessToken: () => 'token', scope: [origin] }
  expect(() =>
    TempoId.Client.attestations({ ...options, issuer: 'http://attest.example' }),
  ).toThrow('https')
  await expect(
    TempoId.Client.attest({
      ...options,
      audience: origin,
      issuer: 'http://attest.example',
      type: 'tempo-id',
    }),
  ).rejects.toThrow('https')
})

test('a new session never presents the previous user’s attestations', async () => {
  const { calls, fetch, tempoId } = await setup(({ fetch }) => [
    Attestation.Server.verifier({ audience: origin, fetch, issuer: attestUrl, type: 'tempo-id' }),
  ])
  let accessToken = await tempoId.accessToken({ sub: 'user_01TEST' })
  const client = ClientMppx.create({
    fetch,
    identity: [
      TempoId.Client.attestations({
        accessToken: () => accessToken,
        fetch,
        issuer: attestUrl,
        scope: [origin],
        types: ['tempo-id'],
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  const first = await client.fetch(url)
  expect(((await first.json()) as { claims: Attestation.Claims }[])[0]!.claims.sub).toBe(
    'user_01TEST',
  )

  accessToken = await tempoId.accessToken({ sub: 'user_02OTHER' })
  const second = await client.fetch(url)
  expect(second.status).toBe(200)
  expect(((await second.json()) as { claims: Attestation.Claims }[])[0]!.claims.sub).toBe(
    'user_02OTHER',
  )
  expect(calls.filter((call) => call.startsWith(`POST ${attestUrl}`))).toHaveLength(2)
})

test('refuses a token Tempo ID issued for another API', async () => {
  const { issuer, tempoId } = await setup(() => [])
  const accessToken = await tempoId.accessToken({ aud: 'https://other-api.example' })
  const response = await issuer.handle(
    new Request(`${attestUrl}${TempoId.Constants.attestPath}`, {
      body: JSON.stringify({ audience: origin, type: 'tempo-id' }),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
    }),
  )
  expect(response!.status).toBe(401)
})

test('sends the ID token on every exchange, so an email policy can allow tempo-id', async () => {
  const { issuer, tempoId } = await setup(() => [], {
    allow: (user) => user.emailVerified === true && user.email === 'ada@example.com',
  })
  const accessToken = await tempoId.accessToken()
  const idToken = await tempoId.idToken()
  const result = await TempoId.Client.attest({
    accessToken: () => accessToken,
    audience: origin,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      (await issuer.handle(new Request(input, init)))!) as typeof globalThis.fetch,
    idToken: () => idToken,
    issuer: attestUrl,
    type: 'tempo-id',
  })
  expect(result?.attestation).toEqual(expect.any(String))
})

test('answers 400 for an over-long audience', async () => {
  const { issuer, tempoId } = await setup(() => [])
  const accessToken = await tempoId.accessToken()
  const response = await issuer.handle(
    new Request(`${attestUrl}${TempoId.Constants.attestPath}`, {
      body: JSON.stringify({ audience: `https://${'a'.repeat(3_000)}.example`, type: 'tempo-id' }),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
    }),
  )
  expect(response!.status).toBe(400)
})

test('the exchange fails once the issuer stalls past the timeout', async () => {
  const stalled = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
    )) as typeof globalThis.fetch
  await expect(
    TempoId.Client.attest({
      accessToken: () => 'token',
      audience: origin,
      fetch: stalled,
      issuer: attestUrl,
      timeout: 0.05,
      type: 'tempo-id',
    }),
  ).rejects.toThrow()
})

test('a DPoP proof is accepted once, and only for the configured endpoint', async () => {
  const { issuer, tempoId } = await setup(() => [])
  const dpop = await createDpop()
  const accessToken = await tempoId.accessToken({ dpop })
  const endpoint = `${attestUrl}${TempoId.Constants.attestPath}`
  // A proof signed for another host's endpoint, sent to this issuer's path.
  let proofUrl = `https://evil.example${TempoId.Constants.attestPath}`
  const exchange = async (url: string) => {
    let headers: Headers | undefined
    await TempoId.Client.attest({
      accessToken: () => accessToken,
      audience: origin,
      dpop,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers)
        return Response.json({ error: 'stop' }, { status: 500 })
      }) as typeof globalThis.fetch,
      issuer: url.replace(TempoId.Constants.attestPath, ''),
      type: 'tempo-id',
    }).catch(() => {})
    return headers!
  }
  const send = (headers: Headers, url = endpoint) =>
    issuer.handle(
      new Request(url, {
        body: JSON.stringify({ audience: origin, type: 'tempo-id' }),
        headers,
        method: 'POST',
      }),
    )
  const foreign = await exchange(proofUrl)
  expect((await send(foreign, `https://evil.example${TempoId.Constants.attestPath}`))!.status).toBe(
    401,
  )
  proofUrl = endpoint
  const own = await exchange(proofUrl)
  expect((await send(own))!.status).toBe(200)
  expect((await send(own))!.status).toBe(401)
})

test('restores stored attestations only for the signed-in user', async () => {
  const { fetch, tempoId } = await setup(() => [])
  const alice = await tempoId.accessToken({ sub: 'user_ALICE' })
  const stored = (await TempoId.Client.attest({
    accessToken: () => alice,
    audience: origin,
    fetch,
    issuer: attestUrl,
    type: 'tempo-id',
  }))!.attestation
  const presented = async (accessToken: () => string) => {
    const prover = TempoId.Client.attestations({
      accessToken,
      attestations: [stored],
      fetch,
      issuer: attestUrl,
      scope: [origin],
    })
    const request = await prover.prove(new Request(url), { created: 0, nonce: 'n' })
    return request.headers.get(Attestation.Constants.header)
  }
  expect(await presented(() => alice)).toBe(stored)
  const bob = await tempoId.accessToken({ sub: 'user_BOB' })
  expect(await presented(() => bob)).toBeNull()
  expect(
    await presented(() => {
      throw new Error('signed out')
    }),
  ).toBeNull()
})

test('drops the previous user’s attestations from a request already in flight', async () => {
  const { fetch, tempoId } = await setup(() => [])
  let accessToken = await tempoId.accessToken({ sub: 'user_ALICE' })
  const alice = (await TempoId.Client.attest({
    accessToken: () => accessToken,
    audience: origin,
    fetch,
    issuer: attestUrl,
    type: 'tempo-id',
  }))!.attestation
  const prover = TempoId.Client.attestations({
    accessToken: () => accessToken,
    fetch,
    issuer: attestUrl,
    scope: [origin],
  })
  const carrying = new Request(url, { headers: { [Attestation.Constants.header]: alice } })
  const context = { created: 0, nonce: 'n' }
  expect((await prover.prove(carrying, context)).headers.get(Attestation.Constants.header)).toBe(
    alice,
  )
  accessToken = await tempoId.accessToken({ sub: 'user_BOB' })
  expect(
    (await prover.prove(carrying, context)).headers.get(Attestation.Constants.header),
  ).toBeNull()
})
