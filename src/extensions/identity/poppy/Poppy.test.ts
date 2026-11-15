import * as Poppy from 'mppx/extensions/identity/poppy'
import * as Identity from 'mppx/identity'
import { describe, expect, test } from 'vp/test'

import * as Jws from './internal/Jws.js'

const clientId = 'https://agent.example/agent.json'
const audience = 'https://api.example.com'
const url = 'https://api.example.com/orders?x=1'

async function setup(
  options: {
    delegationKid?: string
    expiresIn?: number
    /** Signs a custom delegation with the operator key. */
    delegation?: (privateKey: CryptoKey) => Promise<string>
  } = {},
) {
  const operator = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const delegated = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const operatorJwk = { ...(await crypto.subtle.exportKey('jwk', operator.publicKey)), kid: 'op-1' }
  const jwk = await crypto.subtle.exportKey('jwk', delegated.publicKey)
  const delegation = options.delegation
    ? await options.delegation(operator.privateKey)
    : await Poppy.Client.delegate({
        clientId,
        expiresIn: options.expiresIn,
        key: { kid: options.delegationKid ?? 'op-1', privateKey: operator.privateKey },
        publicKey: jwk,
      })
  const fetches: string[] = []
  const documents: Record<string, unknown> = {
    [clientId]: { client_id: clientId, jwks_uri: 'https://agent.example/jwks.json' },
    'https://agent.example/jwks.json': { keys: [operatorJwk] },
  }
  const fetch = (async (input: RequestInfo | URL) => {
    const href = String(input instanceof Request ? input.url : input)
    fetches.push(href)
    const body = documents[href]
    return body ? Response.json(body) : new Response(null, { status: 404 })
  }) as typeof globalThis.fetch
  const prover = Poppy.Client.prover({
    agentId: 'shopping',
    audience,
    clientId,
    delegation: () => delegation,
    key: { jwk, privateKey: delegated.privateKey },
    scope: [audience],
    userId: 'usr_Q7c1vK',
  })
  const prove = (request: Request) => prover.prove(request, { created: 0, nonce: 'n' })
  const verifier = (config: Partial<Poppy.Server.verifier.Config> = {}) =>
    Poppy.Server.verifier({ audience, clients: [clientId], fetch, ...config })
  return { documents, fetches, operatorJwk, prove, verifier }
}

describe('Poppy', () => {
  test('verifies a Session and returns who is calling', async () => {
    const { fetches, prove, verifier } = await setup()
    const request = await prove(new Request(url, { method: 'POST' }))
    expect(request.headers.get('Poppy-Version')).toBe('1.0')
    const check = verifier()
    const result = await check.verify(request)
    expect(result).toMatchObject({
      status: 'valid',
      value: { agentId: 'shopping', clientId, userId: 'usr_Q7c1vK' },
    })
    await check.verify(await prove(new Request(url, { method: 'POST' })))
    expect(fetches).toHaveLength(2) // metadata and keys, cached
  })

  test('rejects a missing header', async () => {
    const { verifier } = await setup()
    expect(await verifier().verify(new Request(url))).toMatchObject({
      status: 'missing',
      code: 400,
    })
  })

  test('binds the Session to the request method and URL', async () => {
    const { prove, verifier } = await setup()
    const signed = await prove(new Request(url))
    const moved = new Request('https://api.example.com/other', { headers: signed.headers })
    expect(await verifier().verify(moved)).toMatchObject({ status: 'invalid' })
  })

  test('rejects another audience and unlisted clients', async () => {
    const { prove, verifier } = await setup()
    const request = await prove(new Request(url))
    expect(await verifier({ audience: 'https://other.example' }).verify(request)).toMatchObject({
      status: 'invalid',
    })
    const refused = await verifier({ clients: ['https://other.example/agent.json'] }).verify(
      request,
    )
    expect(refused).toMatchObject({ status: 'invalid', code: 400 })
    expect(JSON.parse((refused as { reason: string }).reason)).toMatchObject({
      error: 'invalid_session',
    })
  })

  test('fetches nothing for an unlisted client', async () => {
    const { fetches, prove, verifier } = await setup()
    await verifier({ clients: ['https://other.example/agent.json'] }).verify(
      await prove(new Request(url)),
    )
    expect(fetches).toHaveLength(0)
  })

  test('binds an access token with ath, but not a Payment Credential', async () => {
    const { prove, verifier } = await setup()
    const bearer = await prove(new Request(url, { headers: { Authorization: 'Bearer at_123' } }))
    expect(await verifier().verify(bearer)).toMatchObject({ status: 'valid' })
    const swapped = new Request(url, { headers: bearer.headers })
    swapped.headers.set('Authorization', 'Bearer at_456')
    expect(await verifier().verify(swapped)).toMatchObject({ status: 'invalid' })
    const paid = await prove(new Request(url, { headers: { Authorization: 'Payment eyJ' } }))
    expect(await verifier().verify(paid)).toMatchObject({ status: 'valid' })
  })

  test('rejects a delegation from an unknown key', async () => {
    const { prove, verifier } = await setup({ delegationKid: 'op-2' })
    expect(await verifier().verify(await prove(new Request(url)))).toMatchObject({
      status: 'invalid',
    })
  })

  test('rejects a client_id whose metadata does not match', async () => {
    const { documents, prove, verifier } = await setup()
    documents[clientId] = {
      client_id: 'https://evil.example/agent.json',
      jwks_uri: 'https://agent.example/jwks.json',
    }
    expect(await verifier().verify(await prove(new Request(url)))).toMatchObject({
      status: 'unavailable',
    })
  })

  test('limits delegations to 24 hours', async () => {
    await expect(setup({ expiresIn: 24 * 60 * 60 + 1 })).rejects.toThrow(RangeError)
  })

  test('rejects a future-dated delegation', async () => {
    const now = Date.now
    Date.now = () => now() + 2 * 24 * 60 * 60 * 1_000
    const context = await setup().finally(() => {
      Date.now = now
    })
    const result = await context.verifier().verify(await context.prove(new Request(url)))
    expect(result).toMatchObject({ status: 'invalid' })
  })

  test('rejects invalid config', async () => {
    const { verifier } = await setup()
    for (const maxAge of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5])
      expect(() => verifier({ maxAge })).toThrow(RangeError)
    expect(() => verifier({ clients: clientId as never })).toThrow(TypeError)
  })

  test('returns unavailable for a malformed key set, and caches the failure', async () => {
    const { documents, fetches, prove, verifier } = await setup()
    documents['https://agent.example/jwks.json'] = { keys: 'nope' }
    const check = verifier()
    expect(await check.verify(await prove(new Request(url)))).toMatchObject({
      status: 'unavailable',
    })
    expect(await check.verify(await prove(new Request(url)))).toMatchObject({
      status: 'unavailable',
    })
    expect(fetches).toHaveLength(2) // one load: metadata and keys
  })

  test('rejects a non-object cnf.jwk without throwing', async () => {
    const { prove, verifier } = await setup({
      delegation(privateKey) {
        const iat = Math.floor(Date.now() / 1_000)
        return Jws.sign(
          { alg: 'ES256', kid: 'op-1', typ: Poppy.Constants.delegationType },
          { cnf: { jwk: 'x' }, exp: iat + 60, iat, iss: clientId, jti: 'j' },
          privateKey,
        )
      },
    })
    expect(await verifier().verify(await prove(new Request(url)))).toMatchObject({
      status: 'invalid',
    })
  })

  test('only verifies delegations with signing keys', async () => {
    const { documents, operatorJwk, prove, verifier } = await setup()
    documents['https://agent.example/jwks.json'] = { keys: [{ ...operatorJwk, use: 'enc' }] }
    expect(await verifier().verify(await prove(new Request(url)))).toMatchObject({
      status: 'invalid',
    })
  })

  test('reloads keys for an unknown kid after 30 seconds', async () => {
    const { documents, operatorJwk, prove, verifier } = await setup()
    documents['https://agent.example/jwks.json'] = { keys: [{ ...operatorJwk, kid: 'op-0' }] }
    const check = verifier()
    expect(await check.verify(await prove(new Request(url)))).toMatchObject({ status: 'invalid' })
    documents['https://agent.example/jwks.json'] = { keys: [operatorJwk] }
    const now = Date.now
    Date.now = () => now() + 31_000
    try {
      expect(await check.verify(await prove(new Request(url)))).toMatchObject({ status: 'valid' })
    } finally {
      Date.now = now
    }
  })

  test('keeps cached keys when a reload for an unknown kid fails', async () => {
    const { documents, prove, verifier } = await setup()
    const unknown = await setup({ delegationKid: 'op-9' })
    const check = verifier()
    expect(await check.verify(await prove(new Request(url)))).toMatchObject({ status: 'valid' })
    const jwks = documents['https://agent.example/jwks.json']
    delete documents['https://agent.example/jwks.json']
    const now = Date.now
    Date.now = () => now() + 31_000
    try {
      // A Session whose delegation names an unknown kid forces a reload, which fails.
      await check.verify(await unknown.prove(new Request(url)))
      expect(await check.verify(await prove(new Request(url)))).toMatchObject({ status: 'valid' })
    } finally {
      Date.now = now
      documents['https://agent.example/jwks.json'] = jwks
    }
  })

  test('stops using cached keys an hour after they loaded while reloads fail', async () => {
    const { documents, prove, verifier } = await setup({ expiresIn: 2 * 60 * 60 })
    const check = verifier()
    expect(await check.verify(await prove(new Request(url)))).toMatchObject({ status: 'valid' })
    delete documents['https://agent.example/jwks.json']
    const now = Date.now
    try {
      Date.now = () => now() + 10 * 60_000
      expect(await check.verify(await prove(new Request(url)))).toMatchObject({ status: 'valid' })
      Date.now = () => now() + 61 * 60_000
      expect(await check.verify(await prove(new Request(url)))).toMatchObject({
        status: 'unavailable',
      })
    } finally {
      Date.now = now
    }
  })

  test('binds any single token and ignores scheme names in quoted parameters', async () => {
    const { prove, verifier } = await setup()
    const odd = await prove(new Request(url, { headers: { Authorization: 'Bearer 1|abc' } }))
    expect(JSON.parse(atob(odd.headers.get('Poppy-Session')!.split('.')[1]!))).toHaveProperty('ath')
    expect(await verifier().verify(odd)).toMatchObject({ status: 'valid' })
    const quoted = await prove(
      new Request(url, { headers: { Authorization: 'Custom realm="a, Bearer b"' } }),
    )
    expect(await verifier().verify(quoted)).toMatchObject({ status: 'valid' })
  })

  test('parses a long unterminated quoted Authorization value quickly', () => {
    const value = 'Custom x="' + '\\"'.repeat(50_000)
    const start = performance.now()
    expect(Jws.accessToken(new Headers({ Authorization: value }))).toBeUndefined()
    expect(performance.now() - start).toBeLessThan(500)
  })

  test('refuses to sign a Session for an Authorization value it cannot bind', async () => {
    const { prove } = await setup()
    await expect(
      prove(new Request(url, { headers: { Authorization: 'Payment eyJ, Bearer at_123' } })),
    ).rejects.toThrow(TypeError)
  })

  test('binds tab-separated tokens and rejects combined Authorization values', async () => {
    const { prove, verifier } = await setup()
    const tab = await prove(new Request(url, { headers: { Authorization: 'Bearer\tat_123' } }))
    expect(await verifier().verify(tab)).toMatchObject({ status: 'valid' })
    const swapped = new Request(url, { headers: tab.headers })
    swapped.headers.set('Authorization', 'Bearer\tat_456')
    expect(await verifier().verify(swapped)).toMatchObject({ status: 'invalid' })
    const combined = new Request(url, { headers: tab.headers })
    combined.headers.set('Authorization', 'Payment eyJ, Bearer at_123')
    expect(await verifier().verify(combined)).toMatchObject({ status: 'invalid' })
  })

  test('marks Poppy-Session as a bearer identity header', () => {
    expect(Identity.Headers.request).toContain('poppy-session')
  })
})
