import { Base64 } from 'ox'

import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import { isIssuer } from '../../attestation/Token.js'
import { Constants } from '../Constants.js'

/** World IdP's endpoints, read from its discovery document. */
type Metadata = {
  readonly device_authorization_endpoint: string
  readonly token_endpoint: string
  readonly jwks_uri: string
}

/** Claims of a verified World IdP ID token. */
export type IdTokenClaims = {
  readonly sub: string
  readonly acr: string
  readonly amr: readonly string[]
  readonly auth_time: number
}

/** A device authorization from World IdP. */
export type Authorization = {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete?: string | undefined
  readonly expires_in: number
  readonly interval: number
}

/** One poll of World IdP's token endpoint. */
export type Poll =
  | { readonly status: 'approved'; readonly idToken: string }
  | { readonly status: 'pending' | 'slow_down' | 'denied' | 'expired' }

/** Settings of a World IdP confidential client. */
export type Config = {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  readonly clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | undefined
  readonly acr: readonly string[]
  readonly fetch?: typeof globalThis.fetch | undefined
}

/**
 * Calls World IdP as a confidential client: discovery, the device flow (RFC 8628) and ID token
 * validation. Every call times out, and a timeout or outage throws, so callers treat it as
 * unavailable rather than as an answer.
 */
export function create(config: Config) {
  const { acr, clientId, clientSecret, issuer } = config
  // Unwrapped, so a 402 is never paid in a process that also runs the client.
  const fetch = unwrapFetch(config.fetch ?? globalThis.fetch)
  let metadata: Promise<Metadata> | undefined
  const keys = jwks(fetch)

  function discover(): Promise<Metadata> {
    metadata ??= (async () => {
      const body = await json(await get(`${issuer}/.well-known/openid-configuration`))
      const endpoints = [
        body.device_authorization_endpoint,
        body.token_endpoint,
        body.jwks_uri,
      ] as const
      if (
        body.issuer !== issuer ||
        !endpoints.every((url) => typeof url === 'string' && isIssuer(url))
      )
        throw new Error('World IdP discovery is malformed.')
      return body as unknown as Metadata
    })().catch((error) => {
      metadata = undefined
      throw error
    })
    return metadata
  }

  function get(url: string) {
    return fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(Constants.requestTimeout),
    })
  }

  function post(url: string, fields: Record<string, string>) {
    const body = new URLSearchParams(fields)
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    }
    if (config.clientAuthentication === 'client_secret_post') {
      body.set('client_id', clientId)
      body.set('client_secret', clientSecret)
    } else
      headers.authorization = `Basic ${Base64.fromString(
        `${formEncode(clientId)}:${formEncode(clientSecret)}`,
      )}`
    return fetch(url, {
      body,
      headers,
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(Constants.requestTimeout),
    })
  }

  return {
    /** Starts a device attempt. Throws when World IdP is unreachable or refuses it. */
    async start(): Promise<Authorization> {
      const { device_authorization_endpoint } = await discover()
      const response = await post(device_authorization_endpoint, {
        scope: 'openid',
        claims: JSON.stringify({ id_token: { acr: { essential: true, values: acr } } }),
      })
      if (!response.ok) throw new Error(`World IdP answered ${response.status}.`)
      const body = await json(response)
      const { device_code, expires_in, interval, user_code, verification_uri } = body
      const complete = body.verification_uri_complete
      if (
        !isText(device_code) ||
        !isText(user_code) ||
        !isText(verification_uri) ||
        !isIssuer(verification_uri) ||
        (complete !== undefined && !(isText(complete) && isIssuer(complete))) ||
        !isSeconds(expires_in) ||
        (interval !== undefined && !isSeconds(interval))
      )
        throw new Error('World IdP returned a malformed device authorization.')
      return {
        device_code,
        expires_in,
        interval: interval ?? Constants.interval,
        user_code,
        verification_uri,
        ...(complete !== undefined && { verification_uri_complete: complete as string }),
      }
    },
    /** Polls a device attempt once. Throws when World IdP is unavailable or misconfigured. */
    async poll(deviceCode: string): Promise<Poll> {
      const { token_endpoint } = await discover()
      const response = await post(token_endpoint, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      })
      const body = await json(response).catch(() => ({}) as Record<string, unknown>)
      if (response.ok) {
        if (!isText(body.id_token)) throw new Error('World IdP returned no ID token.')
        return { status: 'approved', idToken: body.id_token }
      }
      // Only an OAuth error ends or continues the attempt; anything else is an outage.
      if (response.status !== 400 && response.status !== 401)
        throw new Error('World IdP is unavailable.')
      if (body.error === 'authorization_pending') return { status: 'pending' }
      if (body.error === 'slow_down') return { status: 'slow_down' }
      if (body.error === 'expired_token') return { status: 'expired' }
      if (body.error === 'access_denied' || body.error === 'invalid_grant')
        return { status: 'denied' }
      // invalid_client and other errors are the issuer's misconfiguration, not the person's answer.
      throw new Error('World IdP rejected the request.')
    },
    /**
     * Validates an ID token from the device grant: RS256 signature with World IdP's keys, issuer,
     * audience, times, an authentication at or after the attempt started, and an accepted `acr`.
     * Returns the reason when it is invalid; throws when the keys can't be fetched.
     */
    async verify(token: string, created: number): Promise<IdTokenClaims | string> {
      const parts = token.split('.')
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        return 'The ID token is malformed.'
      let header: Record<string, unknown>
      let claims: Record<string, unknown>
      try {
        header = JSON.parse(Base64.toString(parts[0]!))
        claims = JSON.parse(Base64.toString(parts[1]!))
      } catch {
        return 'The ID token is malformed.'
      }
      if (header?.alg !== 'RS256' || !isText(header.kid))
        return 'The ID token algorithm is not RS256.'
      const now = Math.floor(Date.now() / 1_000)
      const tolerance = Constants.clockTolerance
      if (claims?.iss !== issuer) return 'The ID token issuer is not World IdP.'
      const aud = claims.aud
      const audiences = Array.isArray(aud) ? aud : [aud]
      if (!audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId))
        return 'The ID token is for another client.'
      if (!isText(claims.sub)) return 'The ID token has no subject.'
      if (!isTime(claims.exp) || claims.exp <= now - tolerance) return 'The ID token has expired.'
      if (!isTime(claims.iat) || claims.iat > now + tolerance)
        return 'The ID token was issued in the future.'
      if (!isTime(claims.auth_time) || claims.auth_time > now + tolerance)
        return 'The ID token has no valid auth_time.'
      // The device grant always authenticates afresh: an older authentication is not this attempt's.
      if (claims.auth_time < created - tolerance)
        return 'The World ID authentication predates the attempt.'
      if (!isText(claims.acr) || !acr.includes(claims.acr))
        return 'The World ID authentication class is not accepted.'
      if (!Array.isArray(claims.amr) || !claims.amr.every(isText))
        return 'The ID token has no valid amr.'

      const { jwks_uri } = await discover()
      const key = await keys(jwks_uri, header.kid)
      if (!key) return 'No World IdP key matches the ID token.'
      let valid = false
      try {
        valid = await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          key,
          Base64.toBytes(parts[2]!) as Uint8Array<ArrayBuffer>,
          new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
        )
      } catch {}
      if (!valid) return 'The ID token signature is invalid.'
      return { sub: claims.sub, acr: claims.acr, amr: claims.amr, auth_time: claims.auth_time }
    },
  }
}

/**
 * Resolves World IdP's RS256 keys by key ID from its JSON Web Key Set, cached for five minutes.
 * An unknown key ID refetches the set at most every 30 seconds, and concurrent lookups share one
 * fetch. While a refetch fails, the last set fetched successfully keeps resolving for an hour, so
 * a brief outage never wastes an approval; it throws only when no set is usable.
 */
function jwks(fetch: typeof globalThis.fetch) {
  let cache: { url: string; fetchedAt: number; keys: Promise<Map<string, CryptoKey>> } | undefined
  let good: { url: string; fetchedAt: number; keys: Map<string, CryptoKey> } | undefined
  function load(url: string) {
    const fetchedAt = Date.now()
    const keys = (async () => {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(Constants.requestTimeout),
      })
      if (!response.ok) throw new Error(`World IdP JWKS answered ${response.status}.`)
      const body = await json(response)
      if (!Array.isArray(body.keys)) throw new Error('World IdP JWKS has no keys.')
      const result = new Map<string, CryptoKey>()
      for (const jwk of body.keys) {
        const { alg, e, kid, kty, n, use } = (jwk ?? {}) as Record<string, unknown>
        if (kty !== 'RSA' || !isText(kid) || !isText(n) || !isText(e)) continue
        if ((use !== undefined && use !== 'sig') || (alg !== undefined && alg !== 'RS256')) continue
        try {
          result.set(
            kid,
            await crypto.subtle.importKey(
              'jwk',
              { kty, n, e },
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            ),
          )
        } catch {}
      }
      good = { url, fetchedAt, keys: result }
      return result
    })()
    const entry = { url, fetchedAt, keys }
    cache = entry
    keys.catch(() => {
      if (cache === entry) cache = undefined
    })
    return keys.catch((error) => {
      if (good?.url === url && Date.now() - good.fetchedAt < 3_600_000) return good.keys
      throw error
    })
  }
  return async (url: string, kid: string): Promise<CryptoKey | undefined> => {
    const age = cache && cache.url === url ? Date.now() - cache.fetchedAt : Infinity
    const keys = await (age < 300_000 ? cache!.keys : load(url))
    if (keys.has(kid) || age < 30_000 || age >= 300_000) return keys.get(kid)
    return (await load(url)).get(kid)
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (!(response.headers.get('content-type') ?? '').includes('json') && response.ok)
    throw new Error('World IdP did not answer with JSON.')
  const body = (await response.json()) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new Error('World IdP answered with a malformed body.')
  return body as Record<string, unknown>
}

/** Form-encodes a client credential for HTTP Basic authentication (RFC 6749, section 2.3.1). */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 4_096
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 86_400
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
