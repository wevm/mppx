import { Base64 } from 'ox'

import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import { isIssuer } from '../../attestation/Token.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a request-stage identity verifier for World ID through World IdP, World's OpenID
 * Connect issuer: the request must carry a session this server issued after a person approved
 * the agent with World ID.
 *
 * The server is World IdP's confidential client and runs the OAuth Device Authorization Grant
 * (RFC 8628) for agents: `World.Client.prover` asks it to start an attempt, shows the person
 * the approval link, and polls until they approve in World App. The server validates the ID
 * token (signature, issuer, audience, times and `acr`) and returns a session sealed with
 * `secretKey`, so it keeps no state. Device codes and ID tokens never leave the server. The
 * verified value carries World ID's anonymous, pairwise `subject`, so usage can be limited per
 * human rather than per agent.
 *
 * Register the client at https://auth.world.org/portal. See
 * https://auth.world.org/docs/guides/getting-started.
 *
 * @example
 * ```ts
 * const human = World.Server.verifier({
 *   clientId: process.env.WORLD_CLIENT_ID,
 *   clientSecret: process.env.WORLD_CLIENT_SECRET,
 *   secretKey: process.env.MPP_SECRET_KEY,
 * })
 * mppx.charge({ amount: '0.01', identity: [human] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedHuman> {
  const issuer = (config.issuer ?? Constants.issuer).replace(/\/+$/, '')
  if (!isIssuer(issuer)) throw new TypeError('World ID issuer must be an https URL.')
  if (!config.clientId || !config.clientSecret)
    throw new TypeError('World ID verifier requires clientId and clientSecret.')
  if (!config.secretKey) throw new TypeError('World ID verifier requires secretKey.')
  const acr = config.acr ?? [Constants.acr.orb, Constants.acr.orbFace]
  if (acr.length === 0) throw new TypeError('World ID verifier requires at least one acr.')
  const sessionTtl = config.sessionTtl ?? Constants.sessionTtl
  const tolerance = config.clockTolerance ?? Constants.clockTolerance
  for (const [name, value] of [
    ['sessionTtl', sessionTtl],
    ['clockTolerance', tolerance],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`World ID ${name} must be a non-negative integer of seconds.`)

  const idp = provider({ ...config, acr, issuer })
  const sealer = seal(config.secretKey, `${issuer} ${config.clientId}`)
  const now = () => Math.floor(Date.now() / 1_000)

  async function device(poll: string): Promise<Identity.Verification<Types.VerifiedHuman>> {
    if (poll === 'start') {
      let started: Awaited<ReturnType<typeof idp.start>>
      try {
        started = await idp.start()
      } catch {
        return { status: 'unavailable', reason: 'World ID is unavailable.' }
      }
      const created = now()
      const attempt: Attempt = {
        kind: 'attempt',
        code: started.device_code,
        created,
        expires: created + started.expires_in,
        interval: started.interval,
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        verification_uri_complete: started.verification_uri_complete,
      }
      return pending(attempt, await sealer.seal(attempt))
    }

    const attempt = await sealer.open<Attempt>(poll, 'attempt')
    if (!attempt || attempt.expires <= now())
      return rejected({ status: 'expired' }, 'The World ID attempt expired.')
    let result: Awaited<ReturnType<typeof idp.poll>>
    try {
      result = await idp.poll(attempt.code)
    } catch {
      return { status: 'unavailable', reason: 'World ID is unavailable.' }
    }
    if (result.status === 'pending') return pending(attempt, poll)
    if (result.status === 'slow_down') {
      const slower = { ...attempt, interval: attempt.interval + 5 }
      return pending(slower, await sealer.seal(slower))
    }
    if (result.status !== 'approved')
      return rejected({ status: result.status }, 'World ID was not approved.')

    let claims: IdTokenClaims
    try {
      const verified = await idp.verify(result.idToken, { created: attempt.created, tolerance })
      if (typeof verified === 'string') return rejected({ status: 'denied' }, verified)
      claims = verified
    } catch {
      return { status: 'unavailable', reason: 'World ID keys are unavailable.' }
    }
    const session: Session = {
      kind: 'session',
      acr: claims.acr,
      amr: claims.amr,
      auth_time: claims.auth_time,
      expires: now() + sessionTtl,
      sub: claims.sub,
    }
    const device: Types.Device = {
      status: 'approved',
      session: await sealer.seal(session),
      expires_in: sessionTtl,
    }
    return {
      status: 'missing',
      headers: { [Constants.deviceHeader]: encode(device) },
      reason: 'World ID approved: send the request again with the World-Id session.',
    }
  }

  function pending(attempt: Attempt, token: string): Identity.Verification<never> {
    const device: Types.Device = {
      status: 'pending',
      attempt: token,
      user_code: attempt.user_code,
      verification_uri: attempt.verification_uri,
      ...(attempt.verification_uri_complete && {
        verification_uri_complete: attempt.verification_uri_complete,
      }),
      expires_in: Math.max(0, attempt.expires - now()),
      interval: attempt.interval,
    }
    return {
      status: 'missing',
      headers: { [Constants.deviceHeader]: encode(device) },
      reason: `Approve with World ID at ${attempt.verification_uri_complete ?? attempt.verification_uri} (code ${attempt.user_code}).`,
    }
  }

  return {
    async verify(request) {
      const poll = request.headers.get(Constants.pollHeader)
      // A device-flow call never verifies, so it never reaches the route's handler.
      if (poll !== null) return device(poll.trim())
      const header = request.headers.get(Constants.header)
      if (!header) return required('missing', 'Authenticate with World ID.')
      const session = await sealer.open<Session>(header.trim(), 'session')
      if (!session || session.expires <= now())
        return required('invalid', 'The World ID session is invalid or expired.')
      return {
        status: 'valid',
        value: Object.freeze({
          issuer,
          subject: session.sub,
          acr: session.acr,
          amr: Object.freeze([...session.amr]),
          authTime: new Date(session.auth_time * 1_000),
          expiresAt: new Date(session.expires * 1_000),
        }),
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Client ID registered at World IdP's portal. */
    clientId: string
    /** Client secret registered at World IdP's portal. Keep it on the server. */
    clientSecret: string
    /** How the client authenticates to World IdP, as registered. @default 'client_secret_basic' */
    clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | undefined
    /**
     * Secret that seals device attempts and sessions, such as `MPP_SECRET_KEY`. Share it across
     * instances; changing it ends every session.
     */
    secretKey: string
    /** World IdP issuer. @default 'https://auth.world.org' */
    issuer?: string | undefined
    /**
     * Accepted authentication classes, requested as essential and checked in the ID token.
     * @default [Constants.acr.orb, Constants.acr.orbFace]
     */
    acr?: readonly string[] | undefined
    /** Lifetime, in seconds, of a session after approval. @default 3600 */
    sessionTtl?: number | undefined
    /** Clock tolerance, in seconds, for ID token times. @default 60 */
    clockTolerance?: number | undefined
    /** Fetch used to call World IdP. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
}

type Attempt = {
  readonly kind: 'attempt'
  /** Private device code. */
  readonly code: string
  /** Unix time the attempt started. */
  readonly created: number
  /** Unix time the attempt expires. */
  readonly expires: number
  readonly interval: number
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete?: string | undefined
}

type Session = {
  readonly kind: 'session'
  readonly sub: string
  readonly acr: string
  readonly amr: readonly string[]
  readonly auth_time: number
  /** Unix time the session expires. */
  readonly expires: number
}

type IdTokenClaims = {
  readonly sub: string
  readonly acr: string
  readonly amr: readonly string[]
  readonly auth_time: number
}

function required(status: 'missing' | 'invalid', reason: string) {
  return {
    status,
    headers: {
      [Constants.requiredHeader]: 'device',
      Link: `<${Constants.docs}>; rel="help"`,
    },
    reason,
  } as const
}

function rejected(device: Types.Device, reason: string) {
  return {
    status: 'invalid',
    headers: { [Constants.deviceHeader]: encode(device) },
    reason,
  } as const
}

function encode(device: Types.Device): string {
  return Base64.fromString(JSON.stringify(device), { pad: false, url: true })
}

/**
 * Seals values with AES-GCM under a key derived from `secretKey` and bound to `context` (the
 * issuer and client), so attempts and sessions need no server-side state and can't be read,
 * changed or replayed against another client.
 */
function seal(secretKey: string, context: string) {
  const key = (async () => {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretKey),
      'HKDF',
      false,
      ['deriveKey'],
    )
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('mppx/extensions/identity/world'),
        info: new TextEncoder().encode(context),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  })()
  return {
    async seal(value: Attempt | Session): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(value.kind) },
        await key,
        new TextEncoder().encode(JSON.stringify(value)),
      )
      const bytes = new Uint8Array(12 + sealed.byteLength)
      bytes.set(iv)
      bytes.set(new Uint8Array(sealed), 12)
      return Base64.fromBytes(bytes, { pad: false, url: true })
    },
    async open<value extends Attempt | Session>(
      token: string,
      kind: value['kind'],
    ): Promise<value | undefined> {
      if (token.length > Constants.maxLength || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined
      try {
        const bytes = Base64.toBytes(token)
        const opened = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: bytes.slice(0, 12),
            additionalData: new TextEncoder().encode(kind),
          },
          await key,
          bytes.slice(12),
        )
        const value = JSON.parse(new TextDecoder().decode(opened)) as value
        return value?.kind === kind ? value : undefined
      } catch {
        return undefined
      }
    },
  }
}

/** World IdP's endpoints, read from its discovery document. */
type Metadata = {
  readonly device_authorization_endpoint: string
  readonly token_endpoint: string
  readonly jwks_uri: string
}

/** Calls World IdP: discovery, the device flow and ID token validation. */
function provider(config: verifier.Config & { acr: readonly string[]; issuer: string }) {
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
      signal: AbortSignal.timeout(10_000),
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
      signal: AbortSignal.timeout(10_000),
    })
  }

  return {
    /** Starts a device attempt. Throws when World IdP is unreachable or refuses it. */
    async start() {
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
        verification_uri_complete: complete,
      }
    },
    /** Polls a device attempt once. Throws when World IdP is unavailable. */
    async poll(
      deviceCode: string,
    ): Promise<
      | { status: 'approved'; idToken: string }
      | { status: 'pending' | 'slow_down' | 'denied' | 'expired' }
    > {
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
      // invalid_client and other errors are this server's misconfiguration, not the person's answer.
      throw new Error('World IdP rejected the request.')
    },
    /**
     * Validates an ID token from the device grant: RS256 signature with World IdP's keys, issuer,
     * audience, times, an authentication at or after the attempt started, and an accepted `acr`.
     * Returns the reason when it is invalid; throws when the keys can't be fetched.
     */
    async verify(
      token: string,
      options: { created: number; tolerance: number },
    ): Promise<IdTokenClaims | string> {
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
      const { tolerance } = options
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
      if (claims.auth_time < options.created - tolerance)
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
 * fetch. Throws when the set can't be fetched.
 */
function jwks(fetch: typeof globalThis.fetch) {
  let cache: { url: string; fetchedAt: number; keys: Promise<Map<string, CryptoKey>> } | undefined
  function load(url: string) {
    const keys = (async () => {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
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
      return result
    })()
    const entry = { url, fetchedAt: Date.now(), keys }
    cache = entry
    keys.catch(() => {
      if (cache === entry) cache = undefined
    })
    return keys
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
  return typeof value === 'string' && value !== '' && value.length <= Constants.maxLength
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 86_400
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
