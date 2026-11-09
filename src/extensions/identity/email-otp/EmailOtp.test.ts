import type { RequestListener } from 'node:http'

import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Attestation from 'mppx/extensions/identity/attestation'
import * as EmailOtp from 'mppx/extensions/identity/email-otp'
import * as Identity from 'mppx/identity'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { afterEach, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { jwkThumbprint, keyPair } from '~test/Identity.js'

const issuer = 'https://issuer.example'

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

/** An in-process issuer implementing the email OTP endpoints and JWKS. */
async function createIssuer() {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const inbox: { email: string; code: string }[] = []
  const codes = new Map<string, { audience: string; code: string; email: string }>()
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    calls.push(url.pathname)
    if (url.origin !== issuer) throw new Error(`Unexpected fetch to ${url.origin}`)
    if (url.pathname === Attestation.Constants.jwksPath) {
      const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
      return Response.json({ keys: [{ ...jwk, alg: 'EdDSA', kid: keyId, use: 'sig' }] })
    }
    const body = (await request.json()) as Record<string, string>
    if (url.pathname === EmailOtp.Constants.otpPath) {
      const id = crypto.randomUUID()
      const code = String(100_000 + inbox.length)
      codes.set(id, { audience: body.audience!, code, email: body.email! })
      inbox.push({ code, email: body.email! })
      return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), id })
    }
    if (url.pathname === EmailOtp.Constants.verifyPath) {
      const entry = codes.get(body.id!)
      if (!entry || entry.code !== body.code)
        return Response.json({ error: 'Invalid or expired code.' }, { status: 400 })
      codes.delete(body.id!)
      const iat = Math.floor(Date.now() / 1_000)
      const attestation = await Attestation.sign(
        {
          aud: entry.audience,
          exp: iat + 3_600,
          iat,
          iss: issuer,
          jti: 'a1',
          sub: entry.email,
          type: 'email',
        },
        { key: keys.privateKey, keyId },
      )
      return Response.json({
        attestation,
        expires_at: new Date((iat + 3_600) * 1_000).toISOString(),
      })
    }
    return new Response('Not found', { status: 404 })
  }
  return { calls, fetch, inbox, keyId, keys }
}

const servers: { close(): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function createServer(identity: ReturnType<typeof EmailOtp.Server.verifier>) {
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

test('verifies an email with a one-time code, then pays, in one client call', async () => {
  const fake = await createIssuer()
  const verifier = EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer })
  const server = await createServer(verifier)

  const unverified = await fetch(server.url)
  expect(unverified.status).toBe(401)
  expect(unverified.headers.get(Attestation.Constants.requiredHeader)).toBe(
    `email;issuer="${issuer}"`,
  )

  const prompts: { audience: string; email: string }[] = []
  const client = ClientMppx.create({
    identity: [
      EmailOtp.Client.prover({
        code({ audience, email }) {
          prompts.push({ audience, email })
          return fake.inbox.find((message) => message.email === email)?.code
        },
        email: 'Dana@Example.com',
        fetch: fake.fetch,
        issuers: [issuer],
        scope: [new URL(server.url).origin],
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  const response = await client.fetch(server.url)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ email: 'dana@example.com', id: 'a1', issuer })
  expect(prompts).toEqual([{ audience: new URL(server.url).origin, email: 'Dana@Example.com' }])

  // The attestation is reused until it expires: no second code.
  expect((await client.fetch(server.url)).status).toBe(200)
  expect(fake.inbox).toHaveLength(1)
})

test('accepts an attestation obtained beforehand, as with curl', async () => {
  const fake = await createIssuer()
  const server = await createServer(
    EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer }),
  )
  const origin = new URL(server.url).origin
  const { id } = await EmailOtp.Client.sendCode({
    audience: origin,
    email: 'dana@example.com',
    fetch: fake.fetch,
    issuer,
  })
  const { attestation } = await EmailOtp.Client.verifyCode({
    code: fake.inbox[0]!.code,
    fetch: fake.fetch,
    id,
    issuer,
  })

  const response = await fetch(server.url, {
    headers: { [Attestation.Constants.header]: attestation },
  })
  // Identity passes, so the route asks for payment.
  expect(response.status).toBe(402)
})

test('applies the allow policy with 403', async () => {
  const fake = await createIssuer()
  const server = await createServer(
    EmailOtp.Server.verifier({
      allow: (email) => email.endsWith('@tempo.xyz'),
      audience,
      fetch: fake.fetch,
      issuer,
    }),
  )
  const origin = new URL(server.url).origin
  const { id } = await EmailOtp.Client.sendCode({
    audience: origin,
    email: 'dana@example.com',
    fetch: fake.fetch,
    issuer,
  })
  const { attestation } = await EmailOtp.Client.verifyCode({
    code: fake.inbox[0]!.code,
    fetch: fake.fetch,
    id,
    issuer,
  })
  const response = await fetch(server.url, {
    headers: { [Attestation.Constants.header]: attestation },
  })
  expect(response.status).toBe(403)
  expect(await response.text()).toBe('This email address is not allowed.')
})

test('rejects an attestation bound to another origin', async () => {
  const fake = await createIssuer()
  const server = await createServer(
    EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer }),
  )
  const { id } = await EmailOtp.Client.sendCode({
    audience: 'https://other.example',
    email: 'dana@example.com',
    fetch: fake.fetch,
    issuer,
  })
  const { attestation } = await EmailOtp.Client.verifyCode({
    code: fake.inbox[0]!.code,
    fetch: fake.fetch,
    id,
    issuer,
  })
  const response = await fetch(server.url, {
    headers: { [Attestation.Constants.header]: attestation },
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe('The attestation is for another audience.')
  expect(response.headers.get(Attestation.Constants.requiredHeader)).toBe(
    `email;issuer="${issuer}"`,
  )
})

test('asks for the code again after a wrong one', async () => {
  const fake = await createIssuer()
  const server = await createServer(
    EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer }),
  )
  const attempts: number[] = []
  const client = ClientMppx.create({
    identity: [
      EmailOtp.Client.prover({
        code({ attempt }) {
          attempts.push(attempt)
          return attempt === 1 ? '000000' : fake.inbox[0]!.code
        },
        email: 'dana@example.com',
        fetch: fake.fetch,
        issuers: [issuer],
        scope: '*',
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  expect((await client.fetch(server.url)).status).toBe(200)
  expect(attempts).toEqual([1, 2])
})

test('does not send the email address to an issuer outside `issuers`', async () => {
  const fake = await createIssuer()
  const server = await createServer(
    EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer }),
  )
  const client = ClientMppx.create({
    identity: [
      EmailOtp.Client.prover({
        code: () => '000000',
        email: 'dana@example.com',
        fetch: fake.fetch,
        issuers: ['https://trusted.example'],
        scope: '*',
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  expect((await client.fetch(server.url)).status).toBe(401)
  expect(fake.inbox).toHaveLength(0)
})

test('does not store an attestation for another requirement from an issuer', async () => {
  const fake = await createIssuer()
  const server = await createServer(
    EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer }),
  )
  const planted = await Attestation.sign(
    {
      aud: new URL(server.url).origin,
      exp: Math.floor(Date.now() / 1_000) + 600,
      iat: Math.floor(Date.now() / 1_000),
      iss: 'https://other-issuer.example',
      sub: 'mallory@example.com',
      type: 'email',
    },
    { key: fake.keys.privateKey, keyId: fake.keyId },
  )
  const sent: (string | null)[] = []
  const prover = Attestation.Client.prover({
    acquire: () => planted,
    issuers: [issuer],
    scope: '*',
  })
  const client = ClientMppx.create({
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push(request.headers.get(Attestation.Constants.header))
      return fetch(request)
    },
    identity: [prover],
    methods: [clientMethod],
    polyfill: false,
  })
  expect((await client.fetch(server.url)).status).toBe(401)
  expect(sent).toEqual([null])
})

test('rejects an issuer response with an invalid expiry', async () => {
  const fetch = async () => Response.json({ expires_at: 'soon', id: 'otp-id' })
  await expect(
    EmailOtp.Client.sendCode({
      audience: 'https://api.example',
      email: 'a@b.example',
      fetch,
      issuer,
    }),
  ).rejects.toThrow('malformed')
})

test('never sends an address or code to a plaintext http issuer', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return Response.json({ expires_at: new Date(Date.now() + 60_000).toISOString(), id: 'otp-id' })
  }
  await expect(
    EmailOtp.Client.sendCode({
      audience: 'https://api.example',
      email: 'a@b.example',
      fetch,
      issuer: 'http://issuer.example',
    }),
  ).rejects.toThrow('https')
  await expect(
    EmailOtp.Client.verifyCode({
      code: '123456',
      fetch,
      id: 'otp-id',
      issuer: 'http://issuer.example',
    }),
  ).rejects.toThrow('https')
  expect(calls).toBe(0)
})

test('requires issuers to acquire attestations', () => {
  expect(() => Attestation.Client.prover({ acquire: () => undefined, scope: '*' })).toThrow(
    'must list its issuers',
  )
})

test("accepts the server's own identity system through Identity.from, or email", async () => {
  const fake = await createIssuer()
  const email = EmailOtp.Server.verifier({ audience, fetch: fake.fetch, issuer })
  const apiKey = Identity.from({
    verify(request) {
      const key = request.headers.get('X-Api-Key')
      if (!key) return undefined
      if (key !== 'key-1') throw new Identity.Rejection('Unknown API key.', { code: 403 })
      return { customer: 'acme' }
    },
  })
  const either = Identity.anyOf(email, apiKey)
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const listener = ServerRequest.toNodeListener(async (request) => {
    const result = await mppx.charge({ ...charge, identity: [either] })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      Response.json({ apiKey: result.identity?.get(apiKey), email: result.identity?.get(email) }),
    )
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)

  const none = await fetch(server.url)
  expect(none.status).toBe(401)
  expect(Attestation.Client.requirements(none.headers)).toEqual([[{ issuer, type: 'email' }]])

  expect((await fetch(server.url, { headers: { 'X-Api-Key': 'wrong' } })).status).toBe(403)

  const client = ClientMppx.create({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set('X-Api-Key', 'key-1')
      return fetch(request)
    },
    methods: [clientMethod],
    polyfill: false,
  })
  const paid = await client.fetch(server.url)
  expect(paid.status).toBe(200)
  expect(await paid.json()).toEqual({ apiKey: { customer: 'acme' } })

  // The email prover answers the same 401 when the caller has no key.
  const emailClient = ClientMppx.create({
    identity: [
      EmailOtp.Client.prover({
        code: ({ email: address }) => fake.inbox.find((m) => m.email === address)?.code,
        email: 'dana@example.com',
        fetch: fake.fetch,
        issuers: [issuer],
        scope: '*',
      }),
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  const viaEmail = await emailClient.fetch(server.url)
  expect(viaEmail.status).toBe(200)
  expect(await viaEmail.json()).toMatchObject({ email: { email: 'dana@example.com' } })
})

test('calls the issuer with the unwrapped fetch, so it never pays a 402', async () => {
  const calls: string[] = []
  const inner = (async () => {
    calls.push('inner')
    return Response.json({ id: 'otp-id', expires_at: new Date(Date.now() + 60_000).toISOString() })
  }) as typeof globalThis.fetch
  const wrapper = Object.assign(
    (async () => {
      calls.push('wrapper')
      return new Response(null, { status: 402 })
    }) as typeof globalThis.fetch,
    { [Symbol.for('mppx.fetch.wrapper')]: inner },
  )
  await EmailOtp.Client.sendCode({
    audience: 'https://api.example',
    email: 'dana@example.com',
    fetch: wrapper,
    issuer,
  })
  expect(calls).toEqual(['inner'])
})
