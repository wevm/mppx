import { Credential, Method, Receipt, Store, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as TempoId from 'mppx/extensions/identity/tempo-id'
import { Mppx } from 'mppx/server'
import { Base64 } from 'ox'
import { expect, test, vi } from 'vp/test'

const issuer = 'https://id.tempo.xyz'
const chainId = 4217
const clientId = 'app_test'
const origin = 'https://api.example'
const url = `${origin}/haiku`
const payer = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'

const method = Method.from({
  name: 'tempo',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
  },
})
let settlements = 0
const serverMethod = Method.toServer(method, {
  async verify() {
    settlements++
    return Receipt.from({
      method: 'tempo',
      reference: 'ref',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
/** A client method that pays from `source`, as the tempo method names the payer. */
function clientMethod(source: string) {
  return Method.toClient(method, {
    async createCredential({ challenge }) {
      return Credential.serialize({ challenge, payload: { token: 'paid' }, source })
    },
  })
}
const charge = { amount: '1', currency: 'USD', recipient: 'merchant' } as const

/** A stand-in for Tempo ID: an RS256 key set at /oauth2/jwks, and access tokens shaped like Tempo ID's. */
async function createIssuer() {
  const keyPair = (await crypto.subtle.generateKey(
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
    ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
    alg: 'RS256',
    kid: 'k1',
    use: 'sig',
  }
  let fetches = 0
  let unavailable = false
  const fetch = (async (input: RequestInfo | URL) => {
    fetches++
    expect(String(input)).toBe(`${issuer}/oauth2/jwks`)
    if (unavailable) return new Response(null, { status: 503 })
    return Response.json({ keys: [jwk] })
  }) as typeof globalThis.fetch
  async function token(
    options: {
      accounts?: readonly string[]
      compliance?: Record<string, string>
      aud?: string | readonly string[]
      clientId?: string
      dpop?: TempoId.DpopKey
      exp?: number
      kid?: string
      typ?: string
    } = {},
  ) {
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      access_keys: (options.accounts ?? [payer]).map((account) => ({
        account,
        address: account,
        chain_id: chainId,
      })),
      aud: options.aud ?? issuer,
      client_id: options.clientId ?? clientId,
      compliance: options.compliance ?? {},
      ...(options.dpop && { cnf: { jkt: await thumbprint(options.dpop.jwk) } }),
      exp: options.exp ?? now + 300,
      iat: now,
      iss: issuer,
      scope: 'openid offline_access',
      sub: 'user_01TEST',
      tempo_accounts: [],
    }
    const encode = (value: unknown) =>
      Base64.fromString(JSON.stringify(value), { pad: false, url: true })
    const input = `${encode({ alg: 'RS256', kid: options.kid ?? 'k1', typ: options.typ ?? 'at+jwt' })}.${encode(claims)}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keyPair.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
  }
  async function idToken(claims: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000)
    const encode = (value: unknown) =>
      Base64.fromString(JSON.stringify(value), { pad: false, url: true })
    const body = {
      aud: clientId,
      email: 'Ada@Example.com',
      email_verified: true,
      exp: now + 300,
      iss: issuer,
      sub: 'user_01TEST',
      ...claims,
    }
    const input = `${encode({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${encode(body)}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keyPair.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
  }
  const down = () => {
    unavailable = true
  }
  return { down, fetch, fetches: () => fetches, idToken, token }
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

async function setup(config: Partial<TempoId.Server.create.Config> = {}) {
  const tempoIssuer = await createIssuer()
  const tempoId = TempoId.Server.create({
    chainId,
    clientId,
    fetch: tempoIssuer.fetch,
    store: Store.memory(),
    ...config,
  })
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'api.example',
    requiresAuth: true,
    secretKey: 'test-secret-key-test-secret-key!',
  })
  const handler = async (request: Request) => {
    const result = await mppx.charge({
      ...charge,
      identity: { request: [tempoId.verifier], payment: tempoId.paymentCheck },
    })(request)
    if (result.status !== 200) return result.challenge
    return result.withReceipt(Response.json(result.identity?.get(tempoId.paymentCheck)))
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch
  return { fetch, handler, tempoId, tempoIssuer }
}

test("pays from the signed-in user's account with a DPoP-bound token", async () => {
  const { fetch, tempoIssuer } = await setup()
  const dpop = await createDpop()
  const token = await tempoIssuer.token({ dpop })
  const sent: Request[] = []
  const client = ClientMppx.create({
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push(request.clone())
      return fetch(request)
    },
    identity: [TempoId.Client.prover({ accessToken: () => token, dpop, scope: [origin] })],
    methods: [clientMethod(`did:pkh:eip155:${chainId}:${payer}`)],
    polyfill: false,
  })
  const before = settlements
  const response = await client.fetch(url)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ account: payer, clientId, userId: 'user_01TEST' })
  expect(settlements).toBe(before + 1)
  // The 402 named Tempo ID; the paid retry carried the token, a fresh proof and the payment.
  const paid = sent.at(-1)!
  expect(paid.headers.get('Authorization')).toMatch(/^DPoP /)
  expect(paid.headers.get('Payment-Authorization')).toMatch(/^Payment /)
  expect(paid.headers.get('DPoP')).not.toBe(sent[0]!.headers.get('DPoP'))
  // The key set was fetched once and cached.
  expect(tempoIssuer.fetches()).toBe(1)
})

test('refuses a payment from an account the token does not grant, before settlement', async () => {
  const { fetch, tempoIssuer } = await setup()
  const token = await tempoIssuer.token()
  const client = ClientMppx.create({
    fetch,
    identity: [TempoId.Client.prover({ accessToken: () => token, scope: [origin] })],
    methods: [clientMethod(`did:pkh:eip155:${chainId}:${other}`)],
    polyfill: false,
  })
  const before = settlements
  const response = await client.fetch(url)
  expect(response.status).toBe(403)
  expect(settlements).toBe(before)
})

test('advertises Tempo ID in every 402 and challenges a request without a token', async () => {
  const { handler } = await setup()
  const response = await handler(new Request(url))
  expect(response.status).toBe(401)
  expect(response.headers.get('WWW-Authenticate')).toMatch(/DPoP algs="ES256", Bearer/)
})

test.each([
  ['another audience', { aud: 'https://other.example' }],
  ['an extra audience', { aud: [issuer, 'https://other.example'] }],
  ['another app', { clientId: 'app_other' }],
  ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ['an ID token', { typ: 'JWT' }],
] as const)('rejects %s', async (_, options) => {
  const { tempoId, tempoIssuer } = await setup()
  const token = await tempoIssuer.token(options)
  const result = await tempoId.verifier.verify(
    new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
  )
  expect(result.status).not.toBe('valid')
})

test('rejects a DPoP-bound token without its proof, with another URL, or replayed', async () => {
  const { tempoId, tempoIssuer } = await setup()
  const dpop = await createDpop()
  const token = await tempoIssuer.token({ dpop })
  const prover = TempoId.Client.prover({ accessToken: () => token, dpop, scope: '*' })
  const status = async (headers: HeadersInit) =>
    (await tempoId.verifier.verify(new Request(url, { headers }))).status

  expect(await status({ Authorization: `Bearer ${token}` })).toBe('invalid')
  expect(await status({ Authorization: `DPoP ${token}` })).toBe('invalid')
  const other = await prover.prove(new Request(`${origin}/other`), { created: 0, nonce: '' })
  expect(await status(other.headers)).toBe('invalid')
  const signed = await prover.prove(new Request(url), { created: 0, nonce: '' })
  expect(await status(signed.headers)).toBe('valid')
  expect(await status(signed.headers)).toBe('invalid')
})

test('refuses a payment by a method that does not bind its source', async () => {
  const { tempoId, tempoIssuer } = await setup()
  const token = await tempoIssuer.token()
  const request = new Request(url, { headers: { Authorization: `Bearer ${token}` } })
  const source = `did:pkh:eip155:${chainId}:${payer}`

  const result = await tempoId.paymentCheck.verify({
    challenge: { method: 'stripe' },
    credential: { source },
    request,
  } as never)

  expect(result.status).toBe('forbidden')
})

test('rejects a DPoP proof with a null key', async () => {
  const { tempoId, tempoIssuer } = await setup()
  const dpop = await createDpop()
  const token = await tempoIssuer.token({ dpop })
  const encode = (value: unknown) =>
    Base64.fromString(JSON.stringify(value), { pad: false, url: true })
  const proof = `${encode({ alg: 'ES256', jwk: null, typ: 'dpop+jwt' })}.${encode({})}.AA`

  const result = await tempoId.verifier.verify(
    new Request(url, { headers: { Authorization: `DPoP ${token}`, DPoP: proof } }),
  )

  expect(result.status).toBe('invalid')
})

test('reads the email of an ID token for the same user and app', async () => {
  const { tempoId, tempoIssuer } = await setup()
  const token = await tempoIssuer.token({ compliance: { [payer]: 'clear' } })
  const headers = {
    Authorization: `Bearer ${token}`,
    'Tempo-Id-Token': await tempoIssuer.idToken(),
  }

  const result = await tempoId.verifier.verify(new Request(url, { headers }))

  expect(result).toMatchObject({
    status: 'valid',
    value: { compliance: { [payer]: 'clear' }, email: 'ada@example.com', emailVerified: true },
  })
})

test('rejects an ID token for another user', async () => {
  const { tempoId, tempoIssuer } = await setup()
  const token = await tempoIssuer.token()
  const headers = {
    Authorization: `Bearer ${token}`,
    'Tempo-Id-Token': await tempoIssuer.idToken({ sub: 'user_other' }),
  }

  const result = await tempoId.verifier.verify(new Request(url, { headers }))

  expect(result.status).toBe('invalid')
})

test('allow decides by email', async () => {
  const { tempoId, tempoIssuer } = await setup({
    allow: (user) => user.email?.endsWith('@tempo.xyz') === true,
  })
  const token = await tempoIssuer.token()
  const headers = {
    Authorization: `Bearer ${token}`,
    'Tempo-Id-Token': await tempoIssuer.idToken(),
  }

  const result = await tempoId.verifier.verify(new Request(url, { headers }))

  expect(result.status).toBe('forbidden')
})

test('refuses a payer whose account is not clear, before settlement', async () => {
  const { fetch, tempoIssuer } = await setup()
  const token = await tempoIssuer.token({ compliance: { [payer]: 'blocked' } })
  const client = ClientMppx.create({
    fetch,
    identity: [TempoId.Client.prover({ accessToken: () => token, scope: [origin] })],
    methods: [clientMethod(`did:pkh:eip155:${chainId}:${payer}`)],
    polyfill: false,
  })
  const before = settlements

  const response = await client.fetch(url)

  expect(response.status).toBe(403)
  expect(settlements).toBe(before)
})

test('keeps the loaded keys when a refetch for an unknown key ID fails', async () => {
  const { tempoId, tempoIssuer } = await setup()
  const valid = await tempoIssuer.token()
  const status = async (token: string) =>
    (
      await tempoId.verifier.verify(
        new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      )
    ).status
  expect(await status(valid)).toBe('valid')

  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 60_000)
    tempoIssuer.down()
    const unknown = await tempoIssuer.token({ kid: 'k2' })

    expect(await status(unknown)).toBe('invalid')
    expect(await status(await tempoIssuer.token())).toBe('valid')
    expect(tempoIssuer.fetches()).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})
