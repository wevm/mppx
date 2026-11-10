import type { RequestListener } from 'node:http'

import { clearJwksCache, LinkVerifier } from '@stripe/agent-identity'
import { combineFetch, CredentialFixture, LinkFixture } from '@stripe/agent-identity/testing'
import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Link from 'mppx/extensions/identity/link'
import type * as Identity from 'mppx/identity'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { afterEach, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'

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
      reference: 'test-payment',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
const charge = { amount: '1', currency: 'USD', recipient: 'merchant' } as const
const secretKey = 'test-secret-key-test-secret-key-32'

const servers: { close(): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Link's issuer and one customer's credential, with real keys. */
async function createLink(claims: Record<string, unknown> = {}) {
  // Credential keys are cached per issuer, and every fixture has new ones.
  clearJwksCache()
  const link = await LinkFixture.create()
  const credential = await CredentialFixture.create({
    claims: { email: 'Ada@Example.com', email_verified: true, ...claims },
    issuerUrl: link.issuer,
  })
  return { credential, fetch: combineFetch(link.fetchImpl(), credential.fetchImpl()), link }
}

/** A paid route whose identity verifiers are built for the server's own origin. */
async function createServer(
  verifiers: (origin: string) => readonly Identity.Verifier[],
  options: { requiresAuth?: boolean } = {},
) {
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    requiresAuth: options.requiresAuth ?? true,
    secretKey,
  })
  const requests: Request[] = []
  let identity: readonly Identity.Verifier[] = []
  const listener = ServerRequest.toNodeListener(async (request) => {
    requests.push(request.clone())
    const result = await mppx.charge({ ...charge, identity })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      Response.json(identity.map((verifier) => result.identity?.get(verifier))),
    )
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)
  const origin = new URL(server.url).origin
  identity = verifiers(origin)
  return { origin, requests, url: server.url }
}

test.each([
  [
    'the Link SDK',
    (fetch: typeof globalThis.fetch, origin: string) => {
      const verifier = new LinkVerifier({ fetchImpl: fetch, origin })
      return { attestation: verifier, claims: verifier }
    },
  ],
  [
    'Web Crypto',
    (fetch: typeof globalThis.fetch, origin: string) => ({
      attestation: Link.Server.tokenVerifier({ fetch }),
      claims: Link.Server.presentationVerifier({ audience: origin, fetch }),
    }),
  ],
])(
  'with %s: answers claims and attestation challenges, then pays, in one client call',
  async (_, create) => {
    const { credential, fetch, link } = await createLink()
    const server = await createServer((origin) => {
      const verifiers = create(fetch, origin)
      return [
        Link.Server.claims({
          audience: origin,
          claims: ['email', 'email_verified'],
          purpose: 'Test',
          secretKey,
          verifier: verifiers.claims,
        }),
        Link.Server.attestation({ verifier: verifiers.attestation }),
      ]
    })

    // Both challenges at once, with the claims problem body.
    const unproved = await globalThis.fetch(server.url)
    expect(unproved.status).toBe(401)
    expect(unproved.headers.get('WWW-Authenticate')).toMatch(/Identity-Presentation/)
    expect(unproved.headers.get('WWW-Authenticate')).toMatch(/PrivateToken challenge=/)
    const body = (await unproved.json()) as Link.ClaimsChallenge
    expect(body).toMatchObject({
      aud: server.origin,
      claims: ['email', 'email_verified'],
      purpose: 'Test',
      trusted_issuers: [Link.Constants.issuer],
      type: Link.Constants.claimsRequiredType,
    })

    let tokens = 0
    const presented: { audience: string; claims: readonly string[] }[] = []
    const client = ClientMppx.create({
      identity: [
        Link.Client.claims({
          claims: ['email', 'email_verified'],
          present({ audience, claims, nonce }: Parameters<Link.Present>[0]) {
            presented.push({ audience, claims })
            return credential.present({ aud: audience, disclose: [...claims], nonce })
          },
          scope: [server.origin],
        }),
        Link.Client.attestation({
          scope: [server.origin],
          async token() {
            tokens++
            return (await link.mint()).authorization
          },
        }),
      ],
      methods: [clientMethod],
      polyfill: false,
    })
    const response = await client.fetch(server.url)
    expect(response.status).toBe(200)
    const [claims, attestation] = (await response.json()) as [
      Link.VerifiedClaims,
      Link.VerifiedAttestation,
    ]
    expect(claims).toMatchObject({
      claims: { email: 'Ada@Example.com', email_verified: true },
      email: 'ada@example.com',
      issuer: Link.Constants.issuer,
    })
    expect(attestation.issuer).toBe(Link.Constants.issuer)
    expect(presented).toEqual([{ audience: server.origin, claims: ['email', 'email_verified'] }])

    // The paid retry carried the token in Authorization and the payment beside it.
    const paid = server.requests.at(-1)!
    expect(paid.headers.get('Authorization')).toMatch(/^PrivateToken token=/)
    expect(paid.headers.get('Payment-Authorization')).toMatch(/^Payment /)

    // Both proofs are reused: no new token or presentation.
    expect((await client.fetch(server.url)).status).toBe(200)
    expect(tokens).toBe(1)
    expect(presented).toHaveLength(1)
  },
)

test.each([
  [
    'LinkVerifier',
    (fetch: typeof globalThis.fetch, origin: string) =>
      new LinkVerifier({ fetchImpl: fetch, origin }),
  ],
  ['tokenVerifier', (fetch: typeof globalThis.fetch) => Link.Server.tokenVerifier({ fetch })],
])('%s rejects a forged attestation with a new challenge', async (_, create) => {
  const { fetch, link } = await createLink()
  const server = await createServer((origin) => [
    Link.Server.attestation({ verifier: create(fetch, origin) }),
  ])
  const forged = await link.mint({ corruptAuthenticator: true })
  const response = await globalThis.fetch(server.url, {
    headers: { Authorization: forged.authorization },
  })
  expect(response.status).toBe(401)
  expect(response.headers.get('WWW-Authenticate')).toMatch(/^PrivateToken /)
  expect(await response.text()).toMatch(/invalid_private_token/)

  const valid = await link.mint()
  const accepted = await globalThis.fetch(server.url, {
    headers: { Authorization: valid.authorization },
  })
  // Identity passes, so the route asks for payment.
  expect(accepted.status).toBe(402)
})

test('explains requiresAuth when Authorization holds a Payment credential', async () => {
  const { fetch } = await createLink()
  const server = await createServer(
    (origin) => [
      Link.Server.attestation({ verifier: new LinkVerifier({ fetchImpl: fetch, origin }) }),
    ],
    { requiresAuth: false },
  )
  const response = await globalThis.fetch(server.url, {
    headers: { Authorization: 'Payment e30' },
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toMatch(/requiresAuth: true/)
})

test('rejects a presentation for a nonce it did not issue', async () => {
  const { credential, fetch } = await createLink()
  const server = await createServer((origin) => [
    Link.Server.claims({
      audience: origin,
      claims: ['email', 'email_verified'],
      secretKey,
      verifier: new LinkVerifier({ fetchImpl: fetch, origin }),
    }),
  ])
  const presentation = await credential.present({
    aud: server.origin,
    disclose: ['email', 'email_verified'],
    nonce: 'chosen-by-the-client',
  })
  const response = await globalThis.fetch(server.url, {
    headers: { [Link.Constants.presentationHeader]: presentation },
  })
  expect(response.status).toBe(401)
  expect(((await response.json()) as { detail: string }).detail).toMatch(/nonce/)
})

test('rejects a presentation bound to another audience', async () => {
  const { credential, fetch } = await createLink()
  const server = await createServer((origin) => [
    Link.Server.claims({
      audience: origin,
      claims: ['email', 'email_verified'],
      secretKey,
      verifier: new LinkVerifier({ fetchImpl: fetch, origin }),
    }),
  ])
  const { nonce } = (await (await globalThis.fetch(server.url)).json()) as Link.ClaimsChallenge
  const presentation = await credential.present({
    aud: 'https://other.example',
    disclose: ['email', 'email_verified'],
    nonce,
  })
  const response = await globalThis.fetch(server.url, {
    headers: { [Link.Constants.presentationHeader]: presentation },
  })
  expect(response.status).toBe(401)
  expect(((await response.json()) as { detail: string }).detail).toMatch(
    /invalid_claims_presentation/,
  )
})

test('forbids an unverified email, and applies allow', async () => {
  const unverified = await createLink({ email_verified: false })
  const server = await createServer((origin) => [
    Link.Server.claims({
      audience: origin,
      claims: ['email', 'email_verified'],
      secretKey,
      verifier: new LinkVerifier({ fetchImpl: unverified.fetch, origin }),
    }),
  ])
  const present = async (credential: CredentialFixture, url: string) => {
    const { aud, nonce } = (await (await globalThis.fetch(url)).json()) as Link.ClaimsChallenge
    const presentation = await credential.present({
      aud,
      disclose: ['email', 'email_verified'],
      nonce,
    })
    return globalThis.fetch(url, {
      headers: { [Link.Constants.presentationHeader]: presentation },
    })
  }
  expect((await present(unverified.credential, server.url)).status).toBe(403)

  const verified = await createLink()
  const allowed = await createServer((origin) => [
    Link.Server.claims({
      allow: (claims: Link.VerifiedClaims) => claims.email?.endsWith('@tempo.xyz') === true,
      audience: origin,
      claims: ['email', 'email_verified'],
      secretKey,
      verifier: new LinkVerifier({ fetchImpl: verified.fetch, origin }),
    }),
  ])
  expect((await present(verified.credential, allowed.url)).status).toBe(403)
})

test('client declines challenges for another audience or undeclared claims', async () => {
  const { fetch } = await createLink()
  const server = await createServer((origin) => [
    Link.Server.claims({
      audience: 'https://other.example',
      claims: ['email'],
      secretKey,
      verifier: new LinkVerifier({ fetchImpl: fetch, origin }),
    }),
  ])
  let asked = 0
  const client = ClientMppx.create({
    identity: [
      Link.Client.claims({
        claims: ['email'],
        present() {
          asked++
          return 'unused'
        },
        scope: [server.origin],
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  expect((await client.fetch(server.url)).status).toBe(401)
  expect(asked).toBe(0)
})

test('tokenVerifier verifies tokens like the Link SDK', async () => {
  const { fetch, link } = await createLink()
  const ours = Link.Server.tokenVerifier({ fetch })
  const sdk = new LinkVerifier({ fetchImpl: fetch, origin: 'https://api.example' })
  // The same challenges: one per key, for Link's stable bearer TokenChallenge.
  expect((await ours.attestationChallenge()).wwwAuthenticate).toEqual(
    (await sdk.attestationChallenge()).wwwAuthenticate,
  )
  const token = await link.mint()
  expect(await ours.verifyAttestation(token.authorization)).toEqual(
    await sdk.verifyAttestation(token.authorization),
  )
  // A key Link added after the keys were cached is fetched for the token that names it.
  const rotated = await link.addKey()
  const fresh = await link.mint({ keyIndex: rotated })
  expect((await ours.verifyAttestation(fresh.authorization)).valid).toBe(true)
  for (const bad of [
    await link.mint({ challengeDigestOverride: new Uint8Array(32) }),
    { authorization: 'PrivateToken token="AAIA"' },
    { authorization: 'Bearer abc' },
  ])
    expect(await ours.verifyAttestation(bad.authorization)).toMatchObject({ valid: false })
  // Link unreachable: unavailable, not invalid.
  const down = Link.Server.tokenVerifier({ fetch: async () => new Response('', { status: 502 }) })
  expect(await down.verifyAttestation(token.authorization)).toMatchObject({
    failures: [{ code: 'issuer_unavailable' }],
  })
})

test('presentationVerifier verifies presentations like the Link SDK', async () => {
  const { credential, fetch } = await createLink({ given_name: 'Ada' })
  const audience = 'https://api.example'
  const ours = Link.Server.presentationVerifier({ audience, fetch })
  const sdk = new LinkVerifier({ fetchImpl: fetch, origin: audience })
  const options = { nonce: 'n1', requiredClaims: ['email', 'email_verified'] }
  const present = (overrides: Partial<Parameters<CredentialFixture['present']>[0]> = {}) =>
    credential.present({
      aud: audience,
      disclose: ['email', 'email_verified'],
      nonce: 'n1',
      ...overrides,
    })
  const valid = await present()
  const expected = await sdk.verifyClaims(valid, options)
  expect(expected.valid).toBe(true)
  expect(await ours.verifyClaims(valid, options)).toEqual(expected)
  // Each tampered presentation fails both ways.
  const other = await createLink()
  for (const [why, presentation, opts] of [
    ['another audience', await present({ aud: 'https://other.example' }), options],
    ['another nonce', await present({ nonce: 'n2' }), options],
    ['an undisclosed claim', await present({ disclose: ['email'] }), options],
    ['an old signature', await present({ iat: Math.floor(Date.now() / 1_000) - 600 }), options],
    ['a wrong sd_hash', await present({ sdHashOverride: 'AAAA' }), options],
    ['a wrong KB-JWT typ', await present({ typOverride: 'jwt' }), options],
    ['a dropped disclosure commitment', valid.replace(/~[^~]+~/, '~AAAA~'), options],
    [
      'an unknown issuer key',
      await other.credential.present({
        aud: audience,
        disclose: ['email', 'email_verified'],
        nonce: 'n1',
      }),
      options,
    ],
  ] as const) {
    clearJwksCache()
    expect((await sdk.verifyClaims(presentation, opts)).valid, why).toBe(false)
    expect((await ours.verifyClaims(presentation, opts)).valid, why).toBe(false)
  }
  clearJwksCache()
  const expired = await CredentialFixture.create({
    claims: { email: 'a@b.c', email_verified: true },
    expiresInSeconds: -10,
    issuerUrl: Link.Constants.issuer,
  })
  const stale = await expired.present({ aud: audience, disclose: ['email'], nonce: 'n1' })
  const issuer = await LinkFixture.create()
  const expiredVerifier = Link.Server.presentationVerifier({
    audience,
    fetch: combineFetch(issuer.fetchImpl(), expired.fetchImpl()),
  })
  expect(
    await expiredVerifier.verifyClaims(stale, { nonce: 'n1', requiredClaims: [] }),
  ).toMatchObject({
    failures: [{ message: 'The credential has expired.' }],
  })
  const down = Link.Server.presentationVerifier({
    audience,
    fetch: async () => new Response('', { status: 502 }),
  })
  expect(await down.verifyClaims(valid, options)).toMatchObject({
    failures: [{ code: 'issuer_unavailable' }],
  })
})

test('eager sends a token on the first request', async () => {
  const { fetch, link } = await createLink()
  const server = await createServer((origin) => [
    Link.Server.attestation({ verifier: new LinkVerifier({ fetchImpl: fetch, origin }) }),
  ])
  const client = ClientMppx.create({
    identity: [
      Link.Client.attestation({
        eager: true,
        scope: [server.origin],
        token: async () => (await link.mint()).authorization,
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  expect((await client.fetch(server.url)).status).toBe(200)
  // The unpaid attempt already carried the token: no 401 round trip.
  expect(server.requests).toHaveLength(2)
  expect(server.requests[0]!.headers.get('Authorization')).toMatch(/^PrivateToken /)
})

test('throws on an empty claims list', () => {
  expect(() =>
    Link.Server.claims({
      audience: 'https://api.example',
      claims: [],
      secretKey,
      verifier: {} as Link.LinkVerifier,
    }),
  ).toThrow(/at least one claim/)
})
