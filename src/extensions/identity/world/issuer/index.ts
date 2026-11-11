import { Base64 } from 'ox'

import type { MaybePromise } from '../../../../internal/types.js'
import type * as Store from '../../../../Store.js'
import { Constants as AttestationConstants } from '../../attestation/Constants.js'
import { sign, isIssuer } from '../../attestation/Token.js'
import type * as AttestationTypes from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import * as Idp from '../internal/Idp.js'

/**
 * Creates a World ID issuer: a World IdP confidential client that runs the device flow for agents'
 * humans and signs `Identity-Attestation` tokens of type `world-id` for the servers they call.
 *
 * Run it as a shared service that many servers name as their `issuer`, or inside a server's own
 * app (self-hosted), where `World.Server.verifier` resolves its key in process through
 * `keyResolver`. Either way `handle` answers its three routes, relative to `url`:
 *
 * - `POST /world/device` starts an attempt for an audience (`Constants.devicePath`).
 * - `POST /world/token` polls it; the poll interval is enforced per attempt in `store`.
 * - `GET /.well-known/jwks.json` publishes the attestation key.
 *
 * Records expire on their own: each attempt start deletes attempts and limit windows that ended
 * over a minute ago, so abandoned ones don't accumulate in `store`.
 *
 * Device codes, ID tokens and World's subject never leave the issuer. An approval's ID token is
 * kept with the attempt until it verifies, so a World IdP key outage answers 503 and the next poll
 * retries verification instead of asking the human again.
 *
 * @example
 * ```ts
 * const issuer = World.Issuer.create({
 *   authorize: (request) => isSignedIn(request),
 *   clientId: process.env.WORLD_CLIENT_ID,
 *   clientSecret: process.env.WORLD_CLIENT_SECRET,
 *   secretKey: process.env.MPP_SECRET_KEY,
 *   signingKey,
 *   store,
 *   url: 'https://api.example',
 * })
 * // In the app's fetch handler, before its routes:
 * const answered = await issuer.handle(request)
 * if (answered) return answered
 * ```
 */
export function create(config: create.Config): Issuer {
  const url = config.url.replace(/\/+$/, '')
  if (!isIssuer(url)) throw new TypeError('World ID issuer url must be an https URL.')
  if (!config.clientId || !config.clientSecret)
    throw new TypeError('World ID issuer requires clientId and clientSecret.')
  const subject = config.subject ?? 'pairwise'
  if (subject === 'pairwise' && !config.secretKey)
    throw new TypeError('World ID issuer requires secretKey for pairwise subjects.')
  const acr = config.acr ?? [Constants.acr.orb, Constants.acr.orbFace]
  if (acr.length === 0) throw new TypeError('World ID issuer requires at least one acr.')
  const ttl = config.ttl ?? Constants.attestationTtl
  if (!Number.isSafeInteger(ttl) || ttl <= 0)
    throw new TypeError('World ID issuer ttl must be a positive integer of seconds.')
  const { limit, store } = config
  const base = new URL(url).pathname.replace(/\/+$/, '')
  const idp = Idp.create({
    acr,
    clientAuthentication: config.clientAuthentication,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetch: config.fetch,
    issuer: (config.worldIssuer ?? Constants.worldIssuer).replace(/\/+$/, ''),
  })
  const key = (async () => {
    const jwk = await crypto.subtle.exportKey('jwk', config.signingKey.publicKey)
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x)
      throw new TypeError('World ID issuer signingKey must be an Ed25519 key pair.')
    // RFC 7638 thumbprint, as `Attestation.sign` expects.
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    const keyId = Base64.fromBytes(new Uint8Array(digest), { pad: false, url: true })
    return {
      jwk: { alg: 'EdDSA', crv: jwk.crv, kid: keyId, kty: jwk.kty, use: 'sig', x: jwk.x },
      keyId,
    }
  })()
  const hmac = config.secretKey
    ? crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(config.secretKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    : undefined

  /** Indexes a record under the minute it expires, so {@link sweep} can delete it. */
  async function track(key: string, expires: number) {
    const bucket = Math.ceil(expires / bucketMs)
    await store.update<string, undefined>(`${prefix}expiry:${bucket}`, (current) => {
      const keys = (current as string[] | null) ?? []
      if (keys.includes(key)) return { op: 'noop', result: undefined }
      return { op: 'set', value: [...keys, key], result: undefined }
    })
  }

  /**
   * Deletes records whose minute has passed, a few minutes per call: stores enforce no expiry, so
   * abandoned attempts and limit windows would otherwise stay forever. A record renewed since it
   * was indexed (a limit window that started again) is kept.
   */
  async function sweep() {
    const now = Math.floor(Date.now() / bucketMs)
    const due = await store.update<string, readonly number[]>(
      `${prefix}expiry:cursor`,
      (current) => {
        const cursor = typeof current === 'number' ? current : now
        if (cursor >= now)
          return current === cursor
            ? { op: 'noop', result: [] }
            : { op: 'set', value: now, result: [] }
        const end = Math.min(now, cursor + sweepBuckets)
        return {
          op: 'set',
          value: end,
          result: Array.from({ length: end - cursor }, (_, i) => cursor + i + 1),
        }
      },
    )
    const time = Date.now()
    for (const bucket of due) {
      const bucketKey = `${prefix}expiry:${bucket}`
      const keys = ((await store.get(bucketKey)) as string[] | null) ?? []
      for (const key of keys)
        await store.update<string, undefined>(key, (current) => {
          const record = current as { expires?: number; reset?: number } | null
          if (!record) return { op: 'noop', result: undefined }
          if ((record.expires ?? record.reset ?? 0) > time) return { op: 'noop', result: undefined }
          return { op: 'delete', result: undefined }
        })
      await store.delete(bucketKey)
    }
  }

  async function device(request: Request): Promise<Response> {
    // Cleanup never fails a start.
    await sweep().catch(() => {})
    const body = await read(request)
    const audience = body?.audience
    if (typeof audience !== 'string' || !isOrigin(audience))
      return error(400, 'invalid_request', 'audience must be an origin.')
    if (config.audiences) {
      const allowed =
        typeof config.audiences === 'function'
          ? await config.audiences(audience, request)
          : config.audiences.includes(audience)
      if (!allowed) return error(403, 'access_denied', 'This audience is not served.')
    }
    if (config.authorize && !(await config.authorize(request)))
      return error(403, 'access_denied', 'Not allowed to start a World ID attempt.')
    if (limit) {
      const caller = await limit.key(request)
      if (caller !== undefined) {
        const now = Date.now()
        const limitKey = `${prefix}limit:${caller}`
        await track(limitKey, now + limit.window * 1_000)
        const retryAfter = await store.update(limitKey, (current) => {
          const window = current as { count: number; reset: number } | null
          if (!window || window.reset <= now)
            return { op: 'set', value: { count: 1, reset: now + limit.window * 1_000 }, result: 0 }
          if (window.count >= limit.max)
            return { op: 'noop', result: Math.ceil((window.reset - now) / 1_000) }
          return { op: 'set', value: { ...window, count: window.count + 1 }, result: 0 }
        })
        if (retryAfter > 0)
          return error(429, 'slow_down', 'Too many World ID attempts.', {
            'retry-after': String(retryAfter),
          })
      }
    }
    let started: Idp.Authorization
    try {
      started = await idp.start()
    } catch {
      return error(503, 'temporarily_unavailable', 'World ID is unavailable.')
    }
    const id = Base64.fromBytes(crypto.getRandomValues(new Uint8Array(24)), {
      pad: false,
      url: true,
    })
    const now = Date.now()
    const attempt: Attempt = {
      audience,
      created: Math.floor(now / 1_000),
      deviceCode: started.device_code,
      expires: now + started.expires_in * 1_000,
      interval: started.interval,
      // The first poll waits an interval too (RFC 8628).
      next: now + started.interval * 1_000,
    }
    await track(`${prefix}attempt:${id}`, attempt.expires)
    await store.put(`${prefix}attempt:${id}`, attempt)
    return Response.json(
      {
        expires_in: started.expires_in,
        id,
        interval: started.interval,
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        ...(started.verification_uri_complete && {
          verification_uri_complete: started.verification_uri_complete,
        }),
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  async function token(request: Request): Promise<Response> {
    const body = await read(request)
    const id = body?.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      return error(400, 'invalid_request', 'id is required.')
    const storeKey = `${prefix}attempt:${id}`
    const now = Date.now()
    // Claims this poll's slot atomically, so replays and concurrent polls reach World IdP at most
    // once per interval, on every instance sharing the store.
    const claimed = await store.update<string, 'missing' | 'early' | Attempt>(
      storeKey,
      (current) => {
        const attempt = current as Attempt | null
        if (!attempt) return { op: 'noop', result: 'missing' as const }
        if (attempt.expires <= now) return { op: 'delete', result: 'missing' as const }
        if (attempt.next > now) return { op: 'noop', result: 'early' as const }
        const next = { ...attempt, next: now + attempt.interval * 1_000 }
        return { op: 'set', value: next, result: next }
      },
    )
    if (claimed === 'missing') return error(400, 'expired_token', 'The attempt expired.')
    if (claimed === 'early') return error(400, 'slow_down', 'Polled too soon.')
    const attempt = claimed

    let idToken = attempt.idToken
    if (!idToken) {
      let result: Idp.Poll
      try {
        result = await idp.poll(attempt.deviceCode)
      } catch {
        return error(503, 'temporarily_unavailable', 'World ID is unavailable.')
      }
      if (result.status === 'pending')
        return error(400, 'authorization_pending', 'Waiting for approval.')
      if (result.status === 'slow_down') {
        await store.update(storeKey, (current) => {
          const value = current as Attempt | null
          if (!value) return { op: 'noop', result: undefined }
          const interval = value.interval + Constants.slowDown
          return {
            op: 'set',
            value: { ...value, interval, next: now + interval * 1_000 },
            result: undefined,
          }
        })
        return error(400, 'slow_down', 'Polled too soon.')
      }
      if (result.status !== 'approved') {
        await store.delete(storeKey)
        return result.status === 'expired'
          ? error(400, 'expired_token', 'The attempt expired.')
          : error(400, 'access_denied', 'World ID was not approved.')
      }
      idToken = result.idToken
      // World IdP redeems a device code once: keep its ID token until it verifies.
      await store.put(storeKey, { ...attempt, idToken })
    }

    let claims: Idp.IdTokenClaims | string
    try {
      claims = await idp.verify(idToken, attempt.created)
    } catch {
      return error(503, 'temporarily_unavailable', 'World ID keys are unavailable.')
    }
    await store.delete(storeKey)
    if (typeof claims === 'string') return error(400, 'access_denied', claims)

    const { keyId } = await key
    const iat = Math.floor(Date.now() / 1_000)
    const attestation = await sign(
      {
        acr: claims.acr,
        aud: attempt.audience,
        exp: iat + ttl,
        iat,
        iss: url,
        jti: crypto.randomUUID(),
        sub: await subjectOf(claims.sub, attempt.audience),
        type: Constants.type,
      } as AttestationTypes.Claims,
      { key: config.signingKey.privateKey, keyId },
    )
    return Response.json(
      { attestation, expires_at: new Date((iat + ttl) * 1_000).toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  async function subjectOf(sub: string, audience: string): Promise<string> {
    if (subject === 'world') return sub
    const mac = await crypto.subtle.sign(
      'HMAC',
      await hmac!,
      new TextEncoder().encode(`${audience}\n${sub}`),
    )
    return Base64.fromBytes(new Uint8Array(mac), { pad: false, url: true })
  }

  return {
    url,
    async handle(request) {
      const { pathname } = new URL(request.url)
      if (!pathname.startsWith(base)) return undefined
      const path = pathname.slice(base.length)
      if (path === AttestationConstants.jwksPath) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET')
        return Response.json(
          { keys: [(await key).jwk] },
          { headers: { 'cache-control': 'public, max-age=300' } },
        )
      }
      if (path !== Constants.devicePath && path !== Constants.tokenPath) return undefined
      if (request.method !== 'POST') return methodNotAllowed('POST')
      return path === Constants.devicePath ? device(request) : token(request)
    },
    async keyResolver({ issuer, keyId }) {
      if (issuer !== url || keyId !== (await key).keyId) return undefined
      return config.signingKey.publicKey
    },
    async jwks() {
      return { keys: [(await key).jwk] }
    },
  }
}

export declare namespace create {
  type Config = {
    /** This issuer's URL, the attestations' `iss`, such as `https://api.example` when self-hosted. */
    readonly url: string
    /** Client ID registered at World IdP's portal. */
    readonly clientId: string
    /** Client secret registered at World IdP's portal. Keep it on the server. */
    readonly clientSecret: string
    /** How the client authenticates to World IdP, as registered. @default 'client_secret_basic' */
    readonly clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | undefined
    /** World IdP issuer. @default Constants.worldIssuer */
    readonly worldIssuer?: string | undefined
    /**
     * Accepted World IdP authentication classes, requested as essential and checked in the ID token.
     * @default [Constants.acr.orb, Constants.acr.orbFace]
     */
    readonly acr?: readonly string[] | undefined
    /** Ed25519 key pair that signs attestations; its public key is published at the JWKS route. */
    readonly signingKey: CryptoKeyPair
    /**
     * Holds attempts, their poll schedules and the start limit. Share one atomic store across
     * instances, such as `Store.redis()` or `Store.postgres()`.
     */
    readonly store: Store.AtomicStore
    /**
     * Secret that derives pairwise subjects, such as `MPP_SECRET_KEY`. Required unless
     * `subject` is `'world'`; changing it changes every subject.
     */
    readonly secretKey?: string | undefined
    /**
     * The attested `sub`: `'pairwise'` derives one per audience from World's subject, so servers
     * can't link a human across them; `'world'` passes World's subject through.
     * @default 'pairwise'
     */
    readonly subject?: 'pairwise' | 'world' | undefined
    /**
     * Audiences (server origins) this issuer attests for. Self-hosted, pass the app's own origin.
     * Defaults to any https origin.
     */
    readonly audiences?:
      | readonly string[]
      | ((audience: string, request: Request) => MaybePromise<boolean>)
      | undefined
    /**
     * Decides who may start an attempt, such as the app's signed-in users when self-hosted.
     * Defaults to anyone: then set `limit`.
     */
    readonly authorize?: ((request: Request) => MaybePromise<boolean>) | undefined
    /**
     * Limits attempt starts per caller: World IdP limits starts per client, so one caller could
     * otherwise use up every caller's budget.
     */
    readonly limit?:
      | {
          /** Identifies the caller, such as an API key or a trusted client IP; `undefined` skips the limit. */
          readonly key: (request: Request) => MaybePromise<string | undefined>
          /** Starts allowed per caller per window. */
          readonly max: number
          /** Window length in seconds. */
          readonly window: number
        }
      | undefined
    /** Attestation lifetime in seconds. @default 3600 */
    readonly ttl?: number | undefined
    /** Fetch used to call World IdP. @default globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch | undefined
  }
}

/** A World ID issuer. */
export type Issuer = {
  /** The issuer URL, which servers name as their `issuer` and clients list in `issuers`. */
  readonly url: string
  /** Answers the issuer's routes, or returns `undefined` for any other request. */
  handle(request: Request): Promise<Response | undefined>
  /** Resolves the attestation key in process, for a self-hosted `World.Server.verifier`. */
  keyResolver: AttestationTypes.KeyResolver
  /** The JSON Web Key Set the JWKS route serves. */
  jwks(): Promise<{ keys: readonly Record<string, string>[] }>
}

/** An attempt in the store. */
type Attempt = {
  readonly audience: string
  /** Unix seconds the attempt started. */
  readonly created: number
  readonly deviceCode: string
  /** Unix milliseconds the attempt expires. */
  readonly expires: number
  /** Seconds between polls, raised by slow_down. */
  readonly interval: number
  /** Unix milliseconds before which World IdP is not polled again. */
  readonly next: number
  /** An approval's ID token, kept until it verifies. */
  readonly idToken?: string | undefined
}

const prefix = 'mppx:world-id:'

/** Granularity of the expiry index: records are swept within a minute of expiring. */
const bucketMs = 60_000

/** Most expiry-index minutes one sweep handles, so a start after a long idle stays cheap. */
const sweepBuckets = 10

async function read(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > 4_096) return undefined
  const text = await request.text().catch(() => '')
  if (text.length > 4_096) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function isOrigin(value: string): boolean {
  return isIssuer(value) && URL.canParse(value) && new URL(value).origin === value
}

function error(
  status: number,
  code: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: code, error_description: description },
    { headers: { 'cache-control': 'no-store', ...headers }, status },
  )
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { headers: { allow }, status: 405 })
}
