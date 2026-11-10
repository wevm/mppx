import { Base64, Bytes } from 'ox'

import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Constants.js'

/**
 * Creates a request-stage verifier that requires a Link Agent Attestation Token: proof that
 * Link vouches for the agent, with no personal details.
 *
 * A request without one gets 401 with Link's `WWW-Authenticate: PrivateToken` challenge. The
 * token travels in `Authorization`, so create the server with `requiresAuth: true`: Payment
 * credentials then use `Payment-Authorization` and the token stays on the paid retry.
 *
 * Tokens are bearer tokens: the verifier does not make them single use, and a valid one only
 * says Link issued it. Tokens are checked with {@link tokenVerifier}, which needs only Web
 * Crypto, unless `verifier` is set, such as to a `LinkVerifier` from `@stripe/agent-identity`
 * on Node.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({ methods, requiresAuth: true })
 * const result = await mppx.charge({ amount: '1', identity: [Link.Server.attestation()] })(request)
 * ```
 */
export function attestation(
  config: attestation.Config = {},
): Identity.Verifier<Types.VerifiedAttestation> {
  const verifier = config.verifier ?? tokenVerifier()

  async function challenge(
    status: 'missing' | 'invalid',
    reason: string,
  ): Promise<Exclude<Identity.Verification, { status: 'valid' }>> {
    try {
      const { wwwAuthenticate } = await verifier.attestationChallenge()
      return {
        status,
        reason,
        headers: wwwAuthenticate.map((value) => ['WWW-Authenticate', value]),
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `Link is unavailable: ${error instanceof Error ? error.message : error}`,
      }
    }
  }

  return {
    async verify(request) {
      const authorization = request.headers.get('Authorization')
      if (!authorization || !hasScheme(authorization, Constants.attestationScheme))
        return challenge(
          'missing',
          authorization && hasScheme(authorization, 'Payment')
            ? 'A Link attestation needs Authorization: create the server with requiresAuth: true.'
            : 'A Link attestation is required.',
        )
      const result = await verifier.verifyAttestation(authorization)
      if (result.valid)
        return {
          status: 'valid',
          value: Object.freeze({ issuer: result.issuer, tokenKeyId: result.tokenKeyId }),
        }
      if (unavailable(result.failures))
        return { status: 'unavailable', reason: reason(result.failures, 'Link is unavailable.') }
      return challenge('invalid', reason(result.failures, 'The Link attestation is invalid.'))
    },
  }
}

export declare namespace attestation {
  type Config = {
    /**
     * Verifies tokens, shared by every request: a `LinkVerifier` from `@stripe/agent-identity`, or
     * {@link tokenVerifier} with options. @default tokenVerifier()
     */
    readonly verifier?: Types.AttestationVerifier | undefined
  }
}

/**
 * Creates a request-stage verifier that requires claims Link signed, such as a verified email,
 * presented by the credential holder for this server.
 *
 * A request without a presentation gets 401 with `WWW-Authenticate: Identity-Presentation` and
 * Link's `urn:stripe:link:claims-required` problem body, whose nonce is signed with
 * `secretKey` and expires after {@link Constants.nonceTtl} seconds, so no state is kept. The
 * client presents the claims bound to `audience` and that nonce in `Identity-Presentation`.
 * A presentation verifies again until its nonce expires, including on the paid retry.
 *
 * List it before other verifiers of the route: the rejection body is the first rejecting
 * verifier's, and the client needs this one's.
 *
 * @example
 * ```ts
 * const email = Link.Server.claims({
 *   audience: 'https://api.example',
 *   claims: ['email', 'email_verified'],
 *   purpose: 'Write a haiku about you',
 *   secretKey: env.MPP_SECRET_KEY,
 *   verifier: link,
 * })
 * if (result.status === 200) result.identity?.get(email)?.email
 * ```
 */
export function claims(config: claims.Config): Identity.Verifier<Types.VerifiedClaims> {
  const { allow, purpose } = config
  // One audience for the challenge and the verifier, whatever trailing slash the config has.
  const audience = normalizeAudience(config.audience)
  const verifier = config.verifier ?? presentationVerifier({ audience, issuer: config.issuer })
  const required = [...config.claims]
  if (required.length === 0) throw new TypeError('Link claims needs at least one claim.')
  const ttl = config.nonceTtl ?? Constants.nonceTtl
  const key = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  // Binds a nonce to this verifier's audience and claims.
  const context = (expires: string, random: string) =>
    new TextEncoder().encode(
      ['mppx/link-claims', audience, required.join(' '), expires, random].join('\n'),
    )

  async function nonce(): Promise<string> {
    const expires = String(Math.floor(Date.now() / 1_000) + ttl)
    const random = Base64.fromBytes(Bytes.random(16), { url: true, pad: false })
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', await key, context(expires, random)),
    )
    return [expires, random, Base64.fromBytes(mac, { url: true, pad: false })].join('.')
  }

  /** Returns `value` when it is a nonce this verifier issued that has not expired. */
  async function issued(value: unknown): Promise<string | undefined> {
    if (typeof value !== 'string') return undefined
    const [expires, random, mac, ...rest] = value.split('.')
    if (!expires || !random || !mac || rest.length > 0 || !/^\d{1,12}$/.test(expires))
      return undefined
    if (Number(expires) < Date.now() / 1_000) return undefined
    try {
      const signature = Uint8Array.from(Base64.toBytes(mac))
      const valid = await crypto.subtle.verify(
        'HMAC',
        await key,
        signature,
        context(expires, random),
      )
      return valid ? value : undefined
    } catch {
      return undefined
    }
  }

  async function challenge(
    status: 'missing' | 'invalid',
    detail: string,
  ): Promise<Exclude<Identity.Verification, { status: 'valid' }>> {
    const body = {
      type: Constants.claimsRequiredType,
      aud: audience,
      nonce: await nonce(),
      claims: required,
      ...(purpose && { purpose }),
      formats: [Constants.format],
      trusted_issuers: [config.issuer ?? Constants.issuer],
      detail,
    } satisfies Types.ClaimsChallenge & { detail: string }
    return {
      status,
      reason: JSON.stringify(body),
      headers: [
        ['WWW-Authenticate', Constants.presentationHeader],
        ['Content-Type', 'application/problem+json'],
      ],
    }
  }

  return {
    async verify(request) {
      const presentation = request.headers.get(Constants.presentationHeader)
      if (!presentation) return challenge('missing', 'Link identity claims are required.')
      const presented = await issued(nonceOf(presentation))
      if (!presented) return challenge('invalid', 'The presentation nonce is unknown or expired.')
      const result = await verifier.verifyClaims(presentation, {
        nonce: presented,
        requiredClaims: required,
      })
      if (!result.valid) {
        if (unavailable(result.failures))
          return { status: 'unavailable', reason: reason(result.failures, 'Link is unavailable.') }
        return challenge('invalid', reason(result.failures, 'The Link presentation is invalid.'))
      }
      const disclosed = result.claims
      // A verified email needs both claims, and email_verified must be true.
      const verifiedEmail =
        typeof disclosed.email === 'string' && disclosed.email_verified === true
          ? disclosed.email.toLowerCase()
          : undefined
      if (required.includes('email_verified') && disclosed.email_verified !== true)
        return { status: 'forbidden', reason: 'The email address is not verified.' }
      const value: Types.VerifiedClaims = Object.freeze({
        claims: Object.freeze({ ...disclosed }),
        holderKeyThumbprint: result.holderKeyThumbprint,
        issuer: result.issuer,
        vct: result.vct,
        ...(verifiedEmail && { email: verifiedEmail }),
      })
      if (allow && !(await allow(value, request)))
        return { status: 'forbidden', reason: 'These claims are not allowed.' }
      return { status: 'valid', value }
    },
  }
}

export declare namespace claims {
  type Config = {
    /**
     * Verifies presentations, shared by every request: a `LinkVerifier` from
     * `@stripe/agent-identity`, or {@link presentationVerifier} with options.
     * @default presentationVerifier({ audience, issuer })
     */
    readonly verifier?: Types.ClaimsVerifier | undefined
    /** This server's public origin, such as `https://api.example`: the presentation's audience. */
    readonly audience: string
    /** Claims the presentation must disclose, such as `['email', 'email_verified']`. */
    readonly claims: readonly string[]
    /** Why the server asks, shown to the person whose claims they are. */
    readonly purpose?: string | undefined
    /** Issuer the challenge names: the verifier's. Override only for staging and tests. @default 'https://api.link.com' */
    readonly issuer?: string | undefined
    /** Secret that signs challenge nonces, such as the server's `MPP_SECRET_KEY`. */
    readonly secretKey: string
    /** Seconds a challenge's nonce is accepted for. @default 300 */
    readonly nonceTtl?: number | undefined
    /** Accepts or rejects (`forbidden`, 403) verified claims. Defaults to any. */
    readonly allow?:
      | ((claims: Types.VerifiedClaims, request: Request) => MaybePromise<boolean>)
      | undefined
  }
}

/** The nonce of a presentation's Key Binding JWT, its last `~` segment, unverified. */
function nonceOf(presentation: string): unknown {
  try {
    const kb = presentation.slice(presentation.lastIndexOf('~') + 1)
    const payload = kb.split('.')[1]
    if (!payload) return undefined
    return (JSON.parse(Bytes.toString(Base64.toBytes(payload))) as { nonce?: unknown }).nonce
  } catch {
    return undefined
  }
}

/** Whether an `Authorization` value uses `scheme`. */
function hasScheme(value: string, scheme: string): boolean {
  return value.trimStart().toLowerCase().startsWith(`${scheme.toLowerCase()} `)
}

function unavailable(failures: readonly Types.Failure[]): boolean {
  return failures.some((failure) => failure.code === 'issuer_unavailable')
}

function reason(failures: readonly Types.Failure[], fallback: string): string {
  const first = failures[0]
  return first ? `${first.code}: ${first.message}` : fallback
}

/** Privacy Pass token type of a Link attestation: blind RSA (RFC 9578). */
const tokenType = 0x0002
/** Byte sizes of a token's fields. */
const sizes = { nonce: 32, digest: 32, keyId: 32, authenticator: 256 } as const
const tokenSize = 2 + sizes.nonce + sizes.digest + sizes.keyId + sizes.authenticator
const inputSize = tokenSize - sizes.authenticator
/** `AlgorithmIdentifier { rsaEncryption, NULL }`, the RSA key encoding Web Crypto imports. */
const rsaEncryption = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]
/** `AlgorithmIdentifier { id-RSASSA-PSS, SHA-384, MGF1-SHA-384, salt 48 }`, the one RFC 9578 allows. */
const rsaPss = [
  0x30, 0x3d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a, 0x30, 0x30, 0xa0,
  0x0d, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0xa1, 0x1a,
  0x30, 0x18, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30, 0x0b, 0x06,
  0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0xa2, 0x03, 0x02, 0x01, 0x30,
]

type Key = {
  readonly key: CryptoKey
  readonly spki: string
  readonly notBefore?: number | undefined
}

/**
 * Creates a verifier of Link Agent Attestation Tokens that needs only Web Crypto and `fetch`,
 * so it runs where `@stripe/agent-identity` can't import Link's RSASSA-PSS token key, such as
 * Cloudflare Workers. It makes the same checks: the key is in the token-key directory of Link's
 * issuer metadata, the token answers Link's stable bearer challenge, and its RSA-PSS (SHA-384)
 * signature verifies. {@link attestation} uses it unless given another verifier.
 */
export function tokenVerifier(config: tokenVerifier.Config = {}): Types.AttestationVerifier {
  const issuer = (config.issuer ?? Constants.issuer).replace(/\/+$/, '')
  const issuerOrigin = new URL(issuer).origin
  const maxKeyAge = (config.maxKeyAge ?? 900) * 1_000
  // Unwrapped: fetching issuer documents must never pay a Payment challenge.
  const fetch = unwrapFetch(
    (config.fetch ?? globalThis.fetch) as typeof globalThis.fetch,
  ) as unknown as Fetch
  let cache: { at: number; keys: ReadonlyMap<string, Key> } | undefined
  let loading: Promise<ReadonlyMap<string, Key>> | undefined
  // An unknown key ID is free to mint: refresh for one at most every 30 seconds.
  let refreshedForUnknown = 0

  const get = (url: string) =>
    getJson(url, { fetch, origin: issuerOrigin, timeout: config.timeout ?? 3_000 })

  async function load(): Promise<ReadonlyMap<string, Key>> {
    const metadata = await get(`${issuer}/.well-known/aap-issuer`)
    if (typeof metadata.issuer !== 'string' || metadata.issuer.replace(/\/+$/, '') !== issuer)
      throw new Error('The issuer metadata names another issuer.')
    if (typeof metadata.token_keys !== 'string')
      throw new Error('The issuer metadata has no token_keys.')
    const directory = await get(metadata.token_keys)
    const entries = Array.isArray(directory['token-keys']) ? directory['token-keys'] : []
    const keys = new Map<string, Key>()
    for (const entry of entries as Record<string, unknown>[]) {
      if (entry?.['token-type'] !== tokenType || typeof entry['token-key'] !== 'string') continue
      const spki = fromBase64(entry['token-key'])
      const key = spki && (await importKey(spki))
      if (!spki || !key) continue
      const notBefore = typeof entry['not-before'] === 'number' ? entry['not-before'] : undefined
      keys.set(toBase64(await sha256(spki)), { key, notBefore, spki: toBase64(spki) })
    }
    if (keys.size === 0) throw new Error(`${issuer} published no usable token key.`)
    cache = { at: Date.now(), keys }
    return keys
  }

  function keys(force = false): Promise<ReadonlyMap<string, Key>> {
    if (!force && cache && Date.now() - cache.at < maxKeyAge) return Promise.resolve(cache.keys)
    loading ??= load().finally(() => {
      loading = undefined
    })
    return loading
  }

  const challenge = encodeChallenge(new URL(issuer).host)
  const failure = (code: string, message: string) => ({
    valid: false as const,
    failures: [{ code, message }],
  })

  return {
    async attestationChallenge() {
      const now = Date.now() / 1_000
      const encoded = toBase64(challenge, true)
      const wwwAuthenticate = [...(await keys()).values()]
        .filter((key) => key.notBefore === undefined || now >= key.notBefore)
        .map(
          (key) => `PrivateToken challenge="${encoded}", token-key="${pad(key.spki)}", max-age=300`,
        )
      return { wwwAuthenticate }
    },
    async verifyAttestation(authorization) {
      if (!authorization)
        return failure('incomplete_protocol_request', 'No PrivateToken credential.')
      const raw = parseAuthorization(authorization)
      if (typeof raw === 'string') return failure('malformed_protocol_input', raw)
      if (raw.length !== tokenSize)
        return failure(
          'malformed_protocol_input',
          `The token is ${raw.length} bytes, expected ${tokenSize}.`,
        )
      if (((raw[0]! << 8) | raw[1]!) !== tokenType)
        return failure('malformed_protocol_input', 'The token is not a blind RSA token.')
      const digest = raw.slice(2 + sizes.nonce, 2 + sizes.nonce + sizes.digest)
      if (!equal(digest, await sha256(challenge)))
        return failure('challenge_mismatch', 'The token answers another challenge.')
      const keyId = toBase64(raw.slice(inputSize - sizes.keyId, inputSize))
      let key: Key | undefined
      try {
        key = (await keys()).get(keyId)
        if (!key && Date.now() - refreshedForUnknown > 30_000) {
          refreshedForUnknown = Date.now()
          key = (await keys(true)).get(keyId)
        }
      } catch (error) {
        return failure('issuer_unavailable', error instanceof Error ? error.message : String(error))
      }
      if (!key) return failure('unknown_issuer', 'Link does not publish the token key.')
      if (key.notBefore !== undefined && Date.now() / 1_000 < key.notBefore)
        return failure('unknown_issuer', 'The token key is not active yet.')
      const valid = await crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength: 48 },
        key.key,
        raw.slice(inputSize),
        raw.slice(0, inputSize),
      )
      if (!valid) return failure('invalid_private_token', 'The token signature does not verify.')
      return { valid: true, bindingMode: 'bearer', issuer, tokenKeyId: keyId }
    },
  }
}

export declare namespace tokenVerifier {
  type Config = {
    /** Fetch used for Link's issuer documents. @default globalThis.fetch */
    readonly fetch?: ((input: string, init: RequestInit) => MaybePromise<Response>) | undefined
    /** Issuer URL. Override only for staging and tests. @default 'https://api.link.com' */
    readonly issuer?: string | undefined
    /** Seconds before the token keys are fetched again. @default 900 */
    readonly maxKeyAge?: number | undefined
    /** Milliseconds each issuer request may take. @default 3000 */
    readonly timeout?: number | undefined
  }
}

/** The stable TokenChallenge for `issuerName`: no redemption context, no origin info. */
function encodeChallenge(issuerName: string): Uint8Array<ArrayBuffer> {
  const name = new TextEncoder().encode(issuerName)
  return new Uint8Array([
    tokenType >> 8,
    tokenType & 0xff,
    name.length >> 8,
    name.length & 0xff,
    ...name,
    0,
    0,
    0,
  ])
}

/** Returns the token bytes of a `PrivateToken token="…"` credential, or why it is malformed. */
function parseAuthorization(value: string): Uint8Array<ArrayBuffer> | string {
  if (value.length > 8_192) return 'Authorization is too long.'
  const match = /^\s*PrivateToken[ \t]+(.*)$/is.exec(value)
  if (!match || /[\r\n]/.test(value)) return 'Authorization is not a PrivateToken credential.'
  const tokens = [...match[1]!.matchAll(/(?:^|,)\s*token\s*=\s*(?:"([^"]*)"|([^,\s]*))/gi)]
  if (tokens.length !== 1) return 'The credential needs exactly one token parameter.'
  const bytes = fromBase64(tokens[0]![1] ?? tokens[0]![2] ?? '')
  return bytes ?? 'The token is not base64url.'
}

/** Imports an RSA token key, re-wrapping RFC 9578's id-RSASSA-PSS encoding for Web Crypto. */
async function importKey(spki: Uint8Array<ArrayBuffer>): Promise<CryptoKey | undefined> {
  try {
    const outer = tlv(spki, 0)
    if (outer.tag !== 0x30 || outer.end !== spki.length) return undefined
    const algorithm = tlv(spki, outer.start)
    const bits = tlv(spki, algorithm.end)
    if (bits.tag !== 0x03 || bits.end !== outer.end) return undefined
    const identifier = [...spki.slice(outer.start, algorithm.end)]
    const pss = equal(identifier, rsaPss)
    if (!pss && !equal(identifier, rsaEncryption)) return undefined
    const importable = pss
      ? sequence([...rsaEncryption, ...spki.slice(algorithm.end, bits.end)])
      : spki
    const key = await crypto.subtle.importKey(
      'spki',
      importable,
      { name: 'RSA-PSS', hash: 'SHA-384' },
      false,
      ['verify'],
    )
    const { modulusLength } = key.algorithm as RsaHashedKeyAlgorithm
    return modulusLength === sizes.authenticator * 8 ? key : undefined
  } catch {
    return undefined
  }
}

/** Reads one DER tag-length-value at `offset`. */
function tlv(bytes: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = bytes[offset]!
  let length = bytes[offset + 1]!
  let start = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 2) throw new Error('Unsupported DER length.')
    length = 0
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[start + i]!
    start += count
  }
  if (start + length > bytes.length) throw new Error('Truncated DER.')
  return { tag, start, end: start + length }
}

/** A DER SEQUENCE of `contents`. */
function sequence(contents: number[]): Uint8Array<ArrayBuffer> {
  const length =
    contents.length < 0x80
      ? [contents.length]
      : contents.length < 0x100
        ? [0x81, contents.length]
        : [0x82, contents.length >> 8, contents.length & 0xff]
  return new Uint8Array([0x30, ...length, ...contents])
}

function pad(value: string): string {
  return value + '='.repeat((4 - (value.length % 4)) % 4)
}

/**
 * Creates a verifier of Link identity presentations (SD-JWT VC with a Key Binding JWT) that
 * runs `verifyClaimsPresentation` from `@stripe/agent-identity` wherever `fetch` does,
 * Cloudflare Workers included. It reads Link's issuer metadata itself, so the SDK's
 * Node-only token key import never runs. {@link claims} uses it unless given another verifier.
 */
export function presentationVerifier(config: presentationVerifier.Config): Types.ClaimsVerifier {
  const issuer = (config.issuer ?? Constants.issuer).replace(/\/+$/, '')
  const audience = normalizeAudience(config.audience)
  const timeout = config.timeout ?? 3_000
  const base = unwrapFetch(
    (config.fetch ?? globalThis.fetch) as typeof globalThis.fetch,
  ) as unknown as Fetch
  // The SDK refuses redirects with `redirect: 'error'`, which Workers reject: a 3xx is a failure either way.
  const fetch = (input: string, init: RequestInit) =>
    base(input, init.redirect === 'error' ? { ...init, redirect: 'manual' } : init)
  const getMetadata = metadata({ fetch, issuer, maxAge: 3_600_000, timeout })

  return {
    async verifyClaims(presentation, options) {
      if (!presentation)
        return {
          valid: false,
          failures: [{ code: 'incomplete_protocol_request', message: 'No Identity-Presentation.' }],
        }
      const { verifyClaimsPresentation } = await import('@stripe/agent-identity')
      return verifyClaimsPresentation({
        audience,
        fetchImpl: fetch as typeof globalThis.fetch,
        issuer: { issuer, getMetadata: () => getMetadata() } as never,
        // The SDK never refetches Link's credential keys for an unknown key id, so a short
        // cache bounds how long a rotated key is refused, without fetches a caller can trigger.
        jwksTtlSeconds: 300,
        nonce: options.nonce,
        presentation,
        requiredClaims: [...options.requiredClaims],
        timeoutMs: timeout,
      })
    },
  }
}

export declare namespace presentationVerifier {
  type Config = {
    /** This server's public origin: the presentation's audience. */
    readonly audience: string
    /** Fetch used for Link's issuer documents. @default globalThis.fetch */
    readonly fetch?: ((input: string, init: RequestInit) => MaybePromise<Response>) | undefined
    /** Issuer URL. Override only for staging and tests. @default 'https://api.link.com' */
    readonly issuer?: string | undefined
    /** Milliseconds each issuer request may take. @default 3000 */
    readonly timeout?: number | undefined
  }
}

/** The audience as challenged and verified: the origin, without a trailing slash. */
function normalizeAudience(audience: string): string {
  return audience.replace(/\/+$/, '')
}

/** Decodes base64 or base64url, padded or not; `undefined` when it is neither. */
function fromBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return undefined
  try {
    const binary = atob(value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** base64url, unpadded unless `padded` (RFC 9577 auth-params are padded). */
function toBase64(bytes: Uint8Array, padded = false): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const value = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
  return padded ? value : value.replace(/=+$/, '')
}

async function sha256(bytes: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Fetches a JSON object from Link's issuer origin, refusing redirects and other origins. */
async function getJson(
  url: string,
  options: { origin: string; fetch: Fetch; timeout: number },
): Promise<Record<string, unknown>> {
  if (new URL(url).origin !== options.origin) throw new Error(`${url} is not on ${options.origin}.`)
  const response = await options.fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeout),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  const body = (await response.json()) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error(`${url} is not a JSON object.`)
  return body as Record<string, unknown>
}

/** Fetch as the Link verifiers call it. */
type Fetch = (input: string, init: RequestInit) => Response | Promise<Response>

/** Link's issuer metadata, cached for `maxAge` milliseconds. */
function metadata(options: { issuer: string; fetch: Fetch; timeout: number; maxAge: number }) {
  const origin = new URL(options.issuer).origin
  let cache: { at: number; value: Promise<Record<string, unknown>> } | undefined
  return (force = false): Promise<Record<string, unknown>> => {
    if (!force && cache && Date.now() - cache.at < options.maxAge) return cache.value
    const value = getJson(`${options.issuer}/.well-known/aap-issuer`, { ...options, origin }).then(
      (body) => {
        if (typeof body.issuer !== 'string' || body.issuer.replace(/\/+$/, '') !== options.issuer)
          throw new Error('The issuer metadata names another issuer.')
        return body
      },
    )
    cache = { at: Date.now(), value }
    // A failed fetch is retried on the next call.
    value.catch(() => {
      if (cache?.value === value) cache = undefined
    })
    return value
  }
}
