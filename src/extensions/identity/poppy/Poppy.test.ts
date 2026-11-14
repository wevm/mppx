import * as Poppy from 'mppx/extensions/identity/poppy'
import { describe, expect, test } from 'vp/test'

const clientId = 'https://agent.example/agent.json'
const audience = 'https://api.example.com'
const url = 'https://api.example.com/orders?x=1'

async function setup(options: { delegationKid?: string; expiresIn?: number } = {}) {
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
  const delegation = await Poppy.Client.delegate({
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
  return { documents, fetches, prove, verifier }
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
})
