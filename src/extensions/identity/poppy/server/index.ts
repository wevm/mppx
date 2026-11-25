import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import * as Jwt from '../../tempo/internal/Jwt.js'
import { Constants } from '../Constants.js'
import * as Jws from '../internal/Jws.js'
import type * as Types from '../Types.js'

/**
 * Creates a verifier for Poppy's `Poppy-Session` header (Personal Agent Protocol 1.0, spec 5.3).
 *
 * It fetches the Personal Agent's client metadata from `client_id` and its keys from
 * `jwks_uri`, verifies the delegation and the Session JWT, and checks the audience, method, URL,
 * time and access-token binding. The verified value names the agent, the pseudonymous User and
 * the Session, so a route can price or allow by them before any payment Challenge.
 *
 * A Session never grants account access. When the request also carries an access token, the
 * verifier for that token must check it was issued to the Session's `clientId`.
 *
 * @example
 * ```ts
 * const poppy = Poppy.Server.verifier({
 *   audience: 'https://api.example.com',
 *   clients: ['https://agent.example/agent.json'],
 * })
 *
 * mppx.charge({ amount: '0.01', identity: [poppy] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.Session> {
  const { audience, clients, maxAge = Constants.maxAge } = config
  if (!Array.isArray(clients) || !clients.every((client) => typeof client === 'string'))
    throw new TypeError('Poppy clients must be an array of client_id URLs.')
  if (!Number.isInteger(maxAge) || maxAge <= 0)
    throw new RangeError('Poppy maxAge must be a positive integer.')
  const fetch = unwrapFetch(config.fetch ?? globalThis.fetch)
  const cache = new Map<string, { at: number; ttl: number; keys: Promise<JsonWebKey[]> }>()
  // The last key set that loaded for each client, which a failed reload keeps for a while.
  const loaded = new Map<string, { at: number; keys: JsonWebKey[] }>()
  // Spec 5.3: a failed Session check is HTTP 400 with `invalid_session`, not 401, so OAuth
  // clients keep a valid access token.
  const headers = { 'Content-Type': 'application/json' }
  const body = (description: string) =>
    JSON.stringify({ error: 'invalid_session', error_description: description })
  const invalid = (reason: string) =>
    ({ status: 'invalid', code: 400, headers, reason: body(reason) }) as const

  /** Fetches a client's metadata, without following redirects, then its keys (spec 4.1). */
  async function load(clientId: string): Promise<JsonWebKey[]> {
    const options = { redirect: 'manual', signal: AbortSignal.timeout(5_000) } as const
    const response = await fetch(clientId, options)
    if (!response.ok) throw new Error(`Client metadata request failed with ${response.status}.`)
    const metadata = (await response.json()) as { client_id?: unknown; jwks_uri?: unknown }
    if (metadata.client_id !== clientId) throw new Error('client_id does not match its URL.')
    const jwksUri = typeof metadata.jwks_uri === 'string' ? new URL(metadata.jwks_uri) : undefined
    if (jwksUri?.protocol !== 'https:' || jwksUri.hostname !== new URL(clientId).hostname)
      throw new Error('jwks_uri must be HTTPS on the client_id domain.')
    const jwks = await fetch(jwksUri, options)
    if (!jwks.ok) throw new Error(`Key set request failed with ${jwks.status}.`)
    const { keys } = (await jwks.json()) as { keys?: unknown }
    if (!Array.isArray(keys)) throw new Error('The key set has no keys array.')
    return keys.filter(isObject) as JsonWebKey[]
  }

  /**
   * Returns a client's keys, loaded at most `maxAge` seconds ago. A load is cached for 5
   * minutes, and a failed one for 30 seconds, so a failing agent isn't refetched per request.
   * A failed reload keeps the keys that last loaded, so a request that forces a reload can't
   * replace them with the failure, but only for an hour after they loaded, so a removed key
   * stops verifying within an hour even while the agent is unreachable.
   */
  function keys(clientId: string, maxAge: number = Constants.keyCacheTtl) {
    const cached = cache.get(clientId)
    if (cached && Date.now() - cached.at < Math.min(cached.ttl, maxAge) * 1_000) return cached.keys
    const last = loaded.get(clientId)
    const entry = { at: Date.now(), ttl: Constants.keyCacheTtl as number, keys: load(clientId) }
    entry.keys = entry.keys.then(
      (keys) => {
        loaded.set(clientId, { at: Date.now(), keys })
        return keys
      },
      (error) => {
        entry.ttl = Constants.keyRetryAfter
        const left = last ? Constants.keyStaleTtl - (Date.now() - last.at) / 1_000 : 0
        if (left <= 0) throw error
        // Cache the fallback no longer than its hour lasts.
        entry.ttl = Math.min(entry.ttl, left)
        return last!.keys
      },
    )
    cache.set(clientId, entry)
    return entry.keys
  }

  /** The published key with the delegation's `kid`, if it may verify the delegation's `alg`. */
  function signer(jwks: JsonWebKey[], header: Record<string, unknown>) {
    if (typeof header.kid !== 'string') return undefined
    return jwks.find((jwk) => {
      const { alg, key_ops, kid, use } = jwk as JsonWebKey & { kid?: unknown; use?: unknown }
      return (
        kid === header.kid &&
        (use === undefined || use === 'sig') &&
        (key_ops === undefined || (Array.isArray(key_ops) && key_ops.includes('verify'))) &&
        (alg === undefined || alg === header.alg)
      )
    })
  }

  return {
    headers: { request: [Constants.sessionHeader] },
    async verify(request) {
      const token = request.headers.get(Constants.sessionHeader)
      if (!token)
        return {
          status: 'missing',
          code: 400,
          headers,
          reason: body('Send a Poppy-Session header.'),
        }
      const session = Jwt.decode(token)
      if (session?.header.typ !== Constants.sessionType || session.header.alg !== 'ES256')
        return invalid('The Poppy-Session header is not a Session JWT.')

      const { agent_id, ath, aud, htm, htu, iat, iss, jti, sid, sub } = session.claims
      const strings = [iss, sid, sub, jti]
      if (strings.some((value) => typeof value !== 'string' || !value))
        return invalid('The Session JWT is missing a claim.')
      if (agent_id !== undefined && typeof agent_id !== 'string')
        return invalid('The Session JWT agent_id is not a string.')
      if (!URL.canParse(iss) || new URL(iss).protocol !== 'https:')
        return invalid('The Session JWT iss is not an HTTPS client_id.')
      // Checked before any fetch, so callers can't make the verifier request other URLs.
      if (!clients.includes(iss)) return invalid('This Personal Agent is not accepted.')
      if (aud !== audience) return invalid('The Session JWT is for another Company.')
      if (htm !== request.method || htu !== Jwt.htu(request.url))
        return invalid('The Session JWT is for another request.')
      const now = Math.floor(Date.now() / 1_000)
      if (typeof iat !== 'number' || Math.abs(now - iat) > maxAge)
        return invalid('The Session JWT is outside its time window.')
      const accessToken = Jws.accessToken(request.headers)
      if (accessToken === null) return invalid('The Authorization header is malformed.')
      if (accessToken ? ath !== (await Jwt.sha256(accessToken)) : ath !== undefined)
        return invalid('The Session JWT ath does not match the access token.')

      const delegation =
        typeof session.header.poppy_dlg === 'string'
          ? Jwt.decode(session.header.poppy_dlg)
          : undefined
      if (!delegation) return invalid('The Session JWT has no delegation.')
      const { cnf, exp, iat: issued, iss: delegator } = delegation.claims
      if (delegation.header.typ !== Constants.delegationType || delegator !== iss)
        return invalid('The delegation is not for this Personal Agent.')
      if (
        typeof exp !== 'number' ||
        typeof issued !== 'number' ||
        exp <= now ||
        // A future `iat` would stretch the delegation past its 24-hour lifetime.
        issued > now + maxAge ||
        exp <= issued ||
        exp - issued > Constants.maxDelegationLifetime
      )
        return invalid('The delegation has expired.')

      let key: JsonWebKey | undefined
      try {
        key = signer(await keys(iss), delegation.header)
        // An unknown key may be newly published: reload once the cache is 30 seconds old.
        key ??= signer(await keys(iss, Constants.keyRetryAfter), delegation.header)
      } catch {
        return { status: 'unavailable', reason: "The Personal Agent's keys are unavailable." }
      }
      if (!key || !(await Jws.verify(delegation, key, ['ES256', 'PS384'])))
        return invalid('The delegation signature is invalid.')
      const delegated: unknown = isObject(cnf) ? cnf.jwk : undefined
      if (
        !isObject(delegated) ||
        'd' in delegated ||
        session.header.kid !== (await Jwt.thumbprint(delegated as JsonWebKey))
      )
        return invalid('The Session JWT key does not match its delegation.')
      if (!(await Jws.verify(session, delegated as JsonWebKey, ['ES256'])))
        return invalid('The Session JWT signature is invalid.')

      return {
        status: 'valid',
        value: { agentId: agent_id, clientId: iss, sessionId: sid, userId: sub },
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** This Company's identifier, compared with `aud`: its OAuth issuer, or `https://{organization.domain}`. */
    audience: string
    /**
     * Personal Agent `client_id`s to accept. The verifier fetches metadata and keys only for
     * these, so callers can't make it request other URLs, and its key cache stays this size.
     */
    clients: readonly string[]
    /** Accepted seconds between a Session JWT's `iat` and now. @default 60 */
    maxAge?: number | undefined
    /** Fetch for client metadata and keys. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
