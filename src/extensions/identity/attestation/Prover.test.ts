import type { RequestListener } from 'node:http'

import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Attestation from 'mppx/extensions/identity/attestation'
import * as Identity from 'mppx/identity'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { afterEach, beforeAll, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { jwkThumbprint, keyPair } from '~test/Identity.js'

import * as Cache from './internal/Cache.js'
import * as Token from './Token.js'

const issuer = 'https://issuer.example'
const other = 'https://other-issuer.example'
const api = 'https://api.example'
const unpaid = { created: 0, nonce: 'n' }
const paid = { ...unpaid, challenge: {} as never }

let keys: CryptoKeyPair
let keyId: string
beforeAll(async () => {
  keys = await keyPair()
  keyId = await jwkThumbprint(keys.publicKey)
})

const now = () => Math.floor(Date.now() / 1_000)

/** Signs an attestation for `api`, valid for an hour unless overridden. */
function sign(claims: Partial<Attestation.Claims> = {}) {
  const iat = claims.iat ?? now()
  return Attestation.sign(
    {
      aud: api,
      exp: iat + 3_600,
      iat,
      iss: issuer,
      jti: crypto.randomUUID(),
      sub: 'dana@example.com',
      type: 'email',
      ...claims,
    },
    { key: keys, keyId },
  )
}

/** A rejected response from `api` listing `required`. */
function rejected(required: string, status = 401) {
  const response = new Response(null, {
    status,
    headers: { [Attestation.Constants.requiredHeader]: required },
  })
  Object.defineProperty(response, 'url', { value: `${api}/resource` })
  return response
}

/** The retry context of a request to `api` that sent `tokens`. */
function sent(...tokens: string[]) {
  const headers = tokens.length > 0 ? { [Attestation.Constants.header]: tokens.join(', ') } : {}
  return { request: new Request(`${api}/resource`, { headers }) }
}

/** The attestations a prover sends on a request to `api`. */
async function proved(prover: ReturnType<typeof Attestation.Client.prover>, context = unpaid) {
  const request = await prover.prove(new Request(`${api}/resource`), context)
  return request.headers.get(Attestation.Constants.header)
}

test('acquires a requirement listed twice once', async () => {
  let calls = 0
  const prover = Attestation.Client.prover({
    acquire: () => {
      calls++
      return undefined
    },
    issuers: [issuer],
    scope: '*',
  })
  const required = `email;issuer="${issuer}", email;issuer="${issuer}"`
  expect(await prover.retry!(rejected(required), sent())).toBeUndefined()
  expect(calls).toBe(1)
})

test('matches a trusted issuer listed with a trailing slash', async () => {
  let calls = 0
  const prover = Attestation.Client.prover({
    acquire: () => {
      calls++
      return undefined
    },
    issuers: [`${issuer}/`],
    scope: '*',
  })
  await prover.retry!(rejected(`email;issuer="${issuer}"`), sent())
  expect(calls).toBe(1)
})

test('acquires from the other issuers when one fails', async () => {
  const token = await sign({ iss: other })
  const asked: string[] = []
  const prover = Attestation.Client.prover({
    acquire: ({ issuer: from }) => {
      asked.push(from)
      if (from === issuer) throw new Error('issuer down')
      return token
    },
    issuers: [issuer, other],
    scope: '*',
  })
  expect(
    await prover.retry!(rejected(`email;issuer="${issuer}", email;issuer="${other}"`), sent()),
  ).toEqual({ [Attestation.Constants.header]: token })
  expect(asked).toEqual([issuer, other])
  await expect(prover.retry!(rejected(`email;issuer="${issuer}"`), sent())).rejects.toThrow(
    'issuer down',
  )
})

test('acquires every listed requirement, same-type issuers included', async () => {
  const asked: string[] = []
  const prover = Attestation.Client.prover({
    acquire: ({ issuer: from, type }) => {
      asked.push(`${type}@${from}`)
      return sign({ iss: from, type })
    },
    issuers: [issuer, other],
    scope: '*',
  })
  const headers = await prover.retry!(
    rejected(`phone;issuer="${issuer}", phone;issuer="${other}", email;issuer="${other}"`),
    sent(),
  )
  // The header does not say whether a route needs both phone issuers, so both are acquired.
  expect(asked).toEqual([`phone@${issuer}`, `phone@${other}`, `email@${other}`])
  const tokens = new Headers(headers as HeadersInit).get(Attestation.Constants.header)!.split(', ')
  expect(tokens.map((token) => Attestation.decode(token)?.claims.iss)).toEqual([
    issuer,
    other,
    other,
  ])
})

test('meets a group of alternatives with one attestation, trying the next on failure', async () => {
  const third = 'https://third-issuer.example'
  const asked: string[] = []
  const prover = Attestation.Client.prover({
    acquire: ({ issuer: from, type }) => {
      asked.push(`${type}@${from}`)
      if (from === issuer) throw new Error('issuer down')
      if (from === other) return undefined
      return sign({ iss: from, type })
    },
    issuers: [issuer, other, third],
    scope: '*',
  })
  const headers = await prover.retry!(
    rejected(
      `(email;issuer="${issuer}" email;issuer="${other}" email;issuer="${third}" email;issuer="https://untrusted.example"), phone;issuer="${third}", (phone;issuer="${issuer}" phone;issuer="${third}")`,
    ),
    sent(),
  )
  // The failed and declined alternatives fall through to the next; the last group is already met.
  expect(asked).toEqual([`email@${issuer}`, `email@${other}`, `email@${third}`, `phone@${third}`])
  const tokens = new Headers(headers as HeadersInit).get(Attestation.Constants.header)!.split(', ')
  expect(tokens.map((token) => Attestation.decode(token)?.claims.type)).toEqual(['email', 'phone'])
})

test('prefers a held alternative over acquiring another', async () => {
  const held = await sign({ iss: other })
  let calls = 0
  const prover = Attestation.Client.prover({
    acquire: () => {
      calls++
      return undefined
    },
    attestations: [held],
    issuers: [issuer, other],
    scope: '*',
  })
  expect(
    await prover.retry!(rejected(`(email;issuer="${issuer}" email;issuer="${other}")`), sent()),
  ).toEqual({ [Attestation.Constants.header]: held })
  expect(calls).toBe(0)
})

test('keeps the attestations the request carried on the resend, except those replaced', async () => {
  const attached = await sign({ iss: other, type: 'phone' })
  const stale = await sign()
  const fresh = await sign({ jti: 'fresh' })
  const prover = Attestation.Client.prover({ acquire: () => fresh, issuers: [issuer], scope: '*' })
  const headers = await prover.retry!(rejected(`email;issuer="${issuer}"`), sent(attached, stale))
  expect(headers).toEqual({ [Attestation.Constants.header]: `${attached}, ${fresh}` })
})

test('keeps an expiring attestation on the paid retry, and replaces it before paying', async () => {
  // An hour-long attestation with 30 seconds left: inside the refresh margin.
  const token = await sign({ exp: now() + 30, iat: now() - 3_570 })
  const prover = Attestation.Client.prover({ attestations: [token], scope: '*' })
  expect(await proved(prover)).toBeNull()
  expect(await proved(prover, paid)).toBe(token)
})

test('drops a carried attestation that expired, and sends a fresh cached one in its place', async () => {
  const stale = await sign({ exp: now() - 3_600, iat: now() - 7_200 })
  const fresh = await sign()
  const other = await sign({
    aud: 'https://elsewhere.example',
    exp: now() - 3_600,
    iat: now() - 7_200,
  })
  const prover = Attestation.Client.prover({ attestations: [fresh], scope: '*' })
  const request = new Request(api + '/resource', {
    headers: { [Attestation.Constants.header]: [stale, other].join(', ') },
  })
  const result = await prover.prove(request, paid)
  expect(result.headers.get(Attestation.Constants.header)).toBe([other, fresh].join(', '))
})

test('sends a short-lived attestation while more than half its lifetime remains', async () => {
  const token = await sign({ exp: now() + 120 })
  const prover = Attestation.Client.prover({ attestations: [token], scope: '*' })
  expect(await proved(prover)).toBe(token)
})

test('withholds an attestation inside the refresh margin unpaid, but sends it paid', async () => {
  // An issuer 60 seconds behind signs a 120-second attestation: 60 seconds left, half its lifetime.
  const token = await sign({ exp: now() + 60, iat: now() - 60 })
  const prover = Attestation.Client.prover({ attestations: [token], scope: '*' })
  expect(await proved(prover)).toBeNull()
  expect(await proved(prover, paid)).toBe(token)
})

test('resends a just-acquired attestation in the retry headers, inside the refresh margin', async () => {
  // The issuer clock is 550 seconds behind the client, and its attestations live 600 seconds.
  const token = await sign({ exp: now() + 50, iat: now() - 550 })
  const prover = Attestation.Client.prover({ acquire: () => token, issuers: [issuer], scope: '*' })
  const headers = await prover.retry!(rejected(`email;issuer="${issuer}"`), sent())
  expect(headers).toEqual({ [Attestation.Constants.header]: token })
  // The resend carries it once: prove never adds a token already present.
  const resend = await prover.prove(
    new Request(`${api}/resource`, { headers: headers as HeadersInit }),
    unpaid,
  )
  expect(resend.headers.get(Attestation.Constants.header)).toBe(token)
})

test('a late 401 for an old attestation resends with the newer one, without acquiring', async () => {
  const old = await sign()
  const tokens: string[] = []
  const prover = Attestation.Client.prover({
    acquire: async () => {
      const token = await sign()
      tokens.push(token)
      return token
    },
    attestations: [old],
    issuers: [issuer],
    scope: '*',
  })
  const required = `email;issuer="${issuer}"`
  // Two concurrent requests sent the old attestation; the first 401 replaces it.
  expect(await prover.retry!(rejected(required), sent(old))).toEqual({
    [Attestation.Constants.header]: tokens[0],
  })
  // The second 401 arrives late: the new attestation stays, and the resend carries it.
  expect(await prover.retry!(rejected(required), sent(old))).toEqual({
    [Attestation.Constants.header]: tokens[0],
  })
  expect(tokens).toHaveLength(1)
  expect(await proved(prover)).toBe(tokens[0])
})

test('shares one pending acquisition between concurrent retries', async () => {
  let calls = 0
  const token = await sign()
  const prover = Attestation.Client.prover({
    acquire: async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return token
    },
    issuers: [issuer],
    scope: '*',
  })
  const required = `email;issuer="${issuer}"`
  const results = await Promise.all([
    prover.retry!(rejected(required), sent()),
    prover.retry!(rejected(required), sent()),
  ])
  expect(calls).toBe(1)
  expect(results).toEqual([
    { [Attestation.Constants.header]: token },
    { [Attestation.Constants.header]: token },
  ])
})

test('a retry that joined a failed acquisition still resends the other issuers', async () => {
  const token = await sign({ iss: other })
  const asked: string[] = []
  const prover = Attestation.Client.prover({
    acquire: async ({ issuer: from }) => {
      asked.push(from)
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (from === issuer) throw new Error('issuer down')
      return token
    },
    issuers: [issuer, other],
    scope: '*',
  })
  const required = `email;issuer="${issuer}", email;issuer="${other}"`
  const results = await Promise.all([
    prover.retry!(rejected(required), sent()),
    prover.retry!(rejected(required), sent()),
  ])
  expect(results).toEqual([
    { [Attestation.Constants.header]: token },
    { [Attestation.Constants.header]: token },
  ])
  expect(asked).toEqual([issuer, other])
})

test('replaces an advertised attestation even when another verifier makes the status 403', async () => {
  const token = await sign()
  const fresh = await sign({ jti: 'fresh' })
  let calls = 0
  const prover = Attestation.Client.prover({
    acquire: () => {
      calls++
      return fresh
    },
    attestations: [token],
    issuers: [issuer],
    scope: '*',
  })
  expect(await prover.retry!(rejected(`email;issuer="${issuer}"`, 403), sent(token))).toEqual({
    [Attestation.Constants.header]: fresh,
  })
  expect(calls).toBe(1)
})

test('never answers a response from another origin than the request', async () => {
  let calls = 0
  const prover = Attestation.Client.prover({
    acquire: () => {
      calls++
      return undefined
    },
    issuers: [issuer],
    scope: '*',
  })
  const response = new Response(null, {
    status: 401,
    headers: { [Attestation.Constants.requiredHeader]: `email;issuer="${issuer}"` },
  })
  Object.defineProperty(response, 'url', { value: 'https://elsewhere.example/resource' })
  expect(await prover.retry!(response, sent())).toBeUndefined()
  expect(calls).toBe(0)
})

test('hands out frozen requirements', () => {
  const list = Attestation.Client.requirements(
    new Headers({ [Attestation.Constants.requiredHeader]: `phone;issuer="${issuer}"` }),
  )
  expect(list).toEqual([[{ issuer, type: 'phone' }]])
  expect(Object.isFrozen(list)).toBe(true)
  expect(Object.isFrozen(list[0])).toBe(true)
  expect(Object.isFrozen(list[0]![0])).toBe(true)
})

test('cache transitions keep the entry being replaced unless the server rejected it', async () => {
  const entry = Object.freeze({ token: 't', claims: {} as Attestation.Claims })
  const next = Object.freeze({ token: 'u', claims: {} as Attestation.Claims })
  const held = Object.freeze({ phase: 'held', entry } as const)
  const pending = Promise.resolve(undefined)
  const kept = Cache.transition(held, { type: 'acquire', pending })
  expect(kept).toEqual({ phase: 'acquiring', pending, previous: entry })
  expect(Cache.transition(kept, { type: 'settle', entry: undefined })).toEqual(held)
  expect(Cache.transition(kept, { type: 'settle', entry: next })).toEqual({
    phase: 'held',
    entry: next,
  })
  const dropped = Cache.transition(held, { type: 'acquire', pending, rejected: 't' })
  expect(Cache.transition(dropped, { type: 'settle', entry: undefined })).toBeUndefined()
  expect(() => Cache.transition(kept, { type: 'acquire', pending })).toThrow(TypeError)
  expect(() => Cache.transition(held, { type: 'settle', entry })).toThrow(TypeError)
})

const servers: { close(): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

test('requires and obtains a phone attestation through Mppx', async () => {
  const method = Method.from({
    name: 'test',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
    },
  })
  const phone = Attestation.Server.verifier({
    audience: (request) => new URL(request.url).origin,
    issuer,
    keyResolver: ({ keyId: kid }) => (kid === keyId ? keys.publicKey : undefined),
    type: 'phone',
    validate: (claims) => (claims.sub.startsWith('+1') ? undefined : 'Only US numbers.'),
  })
  const mppx = Mppx.create({
    methods: [
      Method.toServer(method, {
        async verify() {
          return Receipt.from({
            method: 'test',
            reference: 'test-payment',
            status: 'success',
            timestamp: new Date().toISOString(),
          })
        },
      }),
    ],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const listener = ServerRequest.toNodeListener(async (request) => {
    const result = await mppx.charge({
      amount: '1',
      currency: 'USD',
      identity: [phone],
      recipient: 'merchant',
    })(request)
    if (result.status !== 200) return result.challenge
    return result.withReceipt(Response.json(result.identity?.get(phone)?.claims))
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)
  const origin = new URL(server.url).origin

  const missing = await fetch(server.url)
  expect(missing.status).toBe(401)
  expect(missing.headers.get(Attestation.Constants.requiredHeader)).toBe(`phone;issuer="${issuer}"`)

  const client = (sub: string) => {
    const asked: string[] = []
    const mppxClient = ClientMppx.create({
      identity: [
        Attestation.Client.prover({
          acquire({ audience, type }) {
            asked.push(type)
            return sign({ aud: audience, sub, type })
          },
          issuers: [issuer],
          scope: [origin],
          types: ['phone'],
        }),
      ],
      methods: [
        Method.toClient(method, {
          async createCredential({ challenge }) {
            return Credential.serialize({ challenge, payload: { token: 'paid' } })
          },
        }),
      ],
      polyfill: false,
    })
    return { asked, fetch: mppxClient.fetch }
  }

  const allowed = client('+15550100')
  const response = await allowed.fetch(server.url)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ sub: '+15550100', type: 'phone' })
  expect(allowed.asked).toEqual(['phone'])

  // A policy rejection is forbidden (403), and the client does not ask again.
  const blocked = client('+445550100')
  const forbidden = await blocked.fetch(server.url)
  expect(forbidden.status).toBe(403)
  expect(await forbidden.text()).toBe('Only US numbers.')
  expect(blocked.asked).toEqual(['phone'])
})

test('obtains one attestation for a route accepting any of two issuers through Mppx', async () => {
  const method = Method.from({
    name: 'test',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
    },
  })
  const email = (from: string) =>
    Attestation.Server.verifier({
      audience: (request) => new URL(request.url).origin,
      issuer: from,
      keyResolver: ({ keyId: kid }) => (kid === keyId ? keys.publicKey : undefined),
      type: 'email',
    })
  const either = Identity.anyOf(email(issuer), email(other))
  const mppx = Mppx.create({
    methods: [
      Method.toServer(method, {
        async verify() {
          return Receipt.from({
            method: 'test',
            reference: 'test-payment',
            status: 'success',
            timestamp: new Date().toISOString(),
          })
        },
      }),
    ],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const listener = ServerRequest.toNodeListener(async (request) => {
    const result = await mppx.charge({
      amount: '1',
      currency: 'USD',
      identity: [either],
      recipient: 'merchant',
    })(request)
    if (result.status !== 200) return result.challenge
    return result.withReceipt(Response.json({ ok: true }))
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)
  const origin = new URL(server.url).origin

  const missing = await fetch(server.url)
  expect(missing.status).toBe(401)
  expect(missing.headers.get(Attestation.Constants.requiredHeader)).toBe(
    `(email;issuer="${issuer}" email;issuer="${other}")`,
  )

  const asked: string[] = []
  const client = ClientMppx.create({
    identity: [
      Attestation.Client.prover({
        acquire({ audience, issuer: from }) {
          asked.push(from)
          return sign({ aud: audience, iss: from })
        },
        issuers: [other, issuer],
        scope: [origin],
      }),
    ],
    methods: [
      Method.toClient(method, {
        async createCredential({ challenge }) {
          return Credential.serialize({ challenge, payload: { token: 'paid' } })
        },
      }),
    ],
    polyfill: false,
  })
  expect((await client.fetch(server.url)).status).toBe(200)
  // The server's listed order decides, not the client's trusted list.
  expect(asked).toEqual([issuer])
})

test('sends an attestation acquired from an issuer whose clock trails, without acquiring again', async () => {
  // The issuer clock is 550 seconds behind the client, and its attestations live 600 seconds.
  let calls = 0
  const prover = Attestation.Client.prover({
    acquire: () => {
      calls++
      return sign({ exp: now() + 50, iat: now() - 550 })
    },
    issuers: [issuer],
    scope: '*',
  })
  const headers = await prover.retry!(rejected(`email;issuer="${issuer}"`), sent())
  const token = new Headers(headers as HeadersInit).get(Attestation.Constants.header)
  // Its margin runs from when the client received it, so the next unpaid request carries it.
  expect(await proved(prover)).toBe(token)
  expect(calls).toBe(1)
})

test('two provers replacing different attestations resend neither rejected one', async () => {
  const staleEmail = await sign()
  const stalePhone = await sign({ iss: other, type: 'phone' })
  const freshEmail = await sign({ jti: 'fresh-email' })
  const freshPhone = await sign({ iss: other, jti: 'fresh-phone', type: 'phone' })
  const client = Identity.Client.from([
    Attestation.Client.prover({ acquire: () => freshEmail, issuers: [issuer], scope: '*' }),
    Attestation.Client.prover({ acquire: () => freshPhone, issuers: [other], scope: '*' }),
  ])
  const sentRequests: Request[] = []
  await client.send(
    (async (request: Request) => {
      sentRequests.push(request)
      if (sentRequests.length > 1) return new Response('ok')
      return rejected(`email;issuer="${issuer}", phone;issuer="${other}"`)
    }) as never,
    new Request(`${api}/resource`, {
      headers: { [Attestation.Constants.header]: `${staleEmail}, ${stalePhone}` },
    }),
  )
  const resent = Token.parseHeader(sentRequests[1]!.headers.get(Attestation.Constants.header))
  expect(new Set(resent)).toEqual(new Set([freshEmail, freshPhone]))
})
