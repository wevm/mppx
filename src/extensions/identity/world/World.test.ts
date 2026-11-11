import type { RequestListener } from 'node:http'

import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Attestation from 'mppx/extensions/identity/attestation'
import * as World from 'mppx/extensions/identity/world'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { afterEach, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { jwkThumbprint, keyPair } from '~test/Identity.js'

const issuer = 'https://world-id.issuer.example'

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
// The test server's URL is built from its socket, so its origin is safe to derive here.
const audience = (request: Request) => new URL(request.url).origin

type Answer = 'approve' | 'pending' | 'slow_down' | 'access_denied' | 'expired_token' | 503

/**
 * An in-process World ID issuer: the device and token endpoints and JWKS. Each poll answers with
 * the next entry of `answers`, then approves.
 */
async function createIssuer(options: { acr?: string; answers?: Answer[] } = {}) {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const answers = [...(options.answers ?? [])]
  const attempts = new Map<string, string>()
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== issuer) throw new Error(`Unexpected fetch to ${url.origin}`)
    calls.push(url.pathname)
    if (url.pathname === Attestation.Constants.jwksPath) {
      const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
      return Response.json({ keys: [{ ...jwk, alg: 'EdDSA', kid: keyId, use: 'sig' }] })
    }
    const body = (await request.json()) as Record<string, string>
    if (url.pathname === World.Constants.devicePath) {
      const id = crypto.randomUUID()
      attempts.set(id, body.audience!)
      return Response.json({
        expires_in: 600,
        id,
        interval: 0,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.world.org/device',
        verification_uri_complete: 'https://auth.world.org/device?user_code=ABCD-EFGH',
      })
    }
    if (url.pathname === World.Constants.tokenPath) {
      const aud = attempts.get(body.id!)
      if (!aud) return Response.json({ error: 'expired_token' }, { status: 400 })
      const answer = answers.shift() ?? 'approve'
      if (answer === 503) return new Response(null, { status: 503 })
      if (answer !== 'approve')
        return Response.json(
          { error: answer === 'pending' ? 'authorization_pending' : answer },
          { status: 400 },
        )
      attempts.delete(body.id!)
      const iat = Math.floor(Date.now() / 1_000)
      const attestation = await Attestation.sign(
        {
          acr: options.acr ?? World.Constants.acr.orb,
          aud,
          exp: iat + 3_600,
          iat,
          iss: issuer,
          jti: 'w1',
          sub: 'human-1',
          type: World.Constants.type,
        } as never,
        { key: keys.privateKey, keyId },
      )
      return Response.json({
        attestation,
        expires_at: new Date((iat + 3_600) * 1_000).toISOString(),
      })
    }
    return new Response('Not found', { status: 404 })
  }
  return { calls, fetch }
}

const servers: { close(): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function createServer(identity: ReturnType<typeof World.Server.verifier>) {
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const listener = ServerRequest.toNodeListener(async (request) => {
    const result = await mppx.charge({ ...charge, identity: [identity] })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json(result.identity?.get(identity)))
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)
  return server
}

function createClient(
  fake: { fetch: typeof globalThis.fetch },
  server: { url: string },
  verification: World.Client.prover.Config['verification'] = () => {},
) {
  return ClientMppx.create({
    identity: [
      World.Client.prover({
        fetch: fake.fetch,
        issuers: [issuer],
        scope: [new URL(server.url).origin],
        verification,
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
}

test('gets World ID approval through the issuer, then pays, in one client call', async () => {
  const fake = await createIssuer({ answers: ['pending', 503] })
  const server = await createServer(World.Server.verifier({ audience, fetch: fake.fetch, issuer }))

  const unverified = await fetch(server.url)
  expect(unverified.status).toBe(401)
  expect(unverified.headers.get(Attestation.Constants.requiredHeader)).toBe(
    `world-id;issuer="${issuer}"`,
  )

  const shown: unknown[] = []
  const client = createClient(fake, server, ({ issuer, origin, url, userCode }) => {
    shown.push({ issuer, origin, url, userCode })
  })
  const response = await client.fetch(server.url)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    acr: World.Constants.acr.orb,
    expiresAt: expect.any(String),
    id: 'w1',
    issuer,
    subject: 'human-1',
  })
  expect(shown).toEqual([
    {
      issuer,
      origin: new URL(server.url).origin,
      url: 'https://auth.world.org/device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    },
  ])

  // The attestation is reused until it expires: no second attempt.
  expect((await client.fetch(server.url)).status).toBe(200)
  expect(fake.calls.filter((path) => path === World.Constants.devicePath)).toHaveLength(1)
})

test('concurrent requests share one attempt', async () => {
  const fake = await createIssuer({ answers: ['pending', 'pending'] })
  const server = await createServer(World.Server.verifier({ audience, fetch: fake.fetch, issuer }))
  let shown = 0
  const client = createClient(fake, server, () => {
    shown++
  })
  const responses = await Promise.all([1, 2, 3].map(() => client.fetch(server.url)))
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
  expect(shown).toBe(1)
  expect(fake.calls.filter((path) => path === World.Constants.devicePath)).toHaveLength(1)
})

test('does not start another attempt right after one is denied', async () => {
  const fake = await createIssuer({ answers: ['access_denied'] })
  const server = await createServer(World.Server.verifier({ audience, fetch: fake.fetch, issuer }))
  const client = createClient(fake, server)
  await expect(client.fetch(server.url)).rejects.toThrow('World ID was not approved.')
  await expect(client.fetch(server.url)).rejects.toThrow('World ID was not approved.')
  expect(fake.calls.filter((path) => path === World.Constants.devicePath)).toHaveLength(1)
})

test('stops without polling when verification declines', async () => {
  const fake = await createIssuer()
  const server = await createServer(World.Server.verifier({ audience, fetch: fake.fetch, issuer }))
  const client = createClient(fake, server, () => false)
  expect((await client.fetch(server.url)).status).toBe(401)
  expect(fake.calls).toEqual([World.Constants.devicePath])
})

test('rejects an authentication class the route does not accept with 403', async () => {
  const fake = await createIssuer({ acr: World.Constants.acr.selfie })
  const server = await createServer(
    World.Server.verifier({
      acr: [World.Constants.acr.orb],
      audience,
      fetch: fake.fetch,
      issuer,
    }),
  )
  const origin = new URL(server.url).origin
  const device = await World.Client.startDevice({ audience: origin, fetch: fake.fetch, issuer })
  const poll = await World.Client.pollDevice({ fetch: fake.fetch, id: device.id, issuer })
  if (poll.status !== 'approved') throw new Error('not approved')
  const response = await fetch(server.url, {
    headers: { [Attestation.Constants.header]: poll.attestation },
  })
  expect(response.status).toBe(403)
})

test('pollDevice: maps the issuer answers', async () => {
  const fake = await createIssuer({
    answers: ['pending', 'slow_down', 503, 'expired_token'],
  })
  const device = await World.Client.startDevice({
    audience: 'https://api.example',
    fetch: fake.fetch,
    issuer,
  })
  const poll = () => World.Client.pollDevice({ fetch: fake.fetch, id: device.id, issuer })
  expect(await poll()).toEqual({ status: 'pending' })
  expect(await poll()).toEqual({ status: 'slow_down' })
  expect(await poll()).toEqual({ status: 'unavailable' })
  await expect(poll()).rejects.toThrow('The World ID attempt expired.')
  // A network failure is unavailable, never a failure.
  const offline = await World.Client.pollDevice({
    fetch: async () => {
      throw new TypeError('fetch failed')
    },
    id: device.id,
    issuer,
  })
  expect(offline).toEqual({ status: 'unavailable' })
  // So is a body that fails after the issuer sent 200 headers.
  const interrupted = await World.Client.pollDevice({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'))
          },
        }),
        { status: 200 },
      ),
    id: device.id,
    issuer,
  })
  expect(interrupted).toEqual({ status: 'unavailable' })
})

test('verifier requires at least one acr', () => {
  expect(() =>
    World.Server.verifier({ acr: [], audience: 'https://api.example', issuer }),
  ).toThrowErrorMatchingInlineSnapshot(`[TypeError: World ID verifier requires at least one acr.]`)
})
