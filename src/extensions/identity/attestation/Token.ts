import { Base64 } from 'ox'

import { Constants } from './Constants.js'
import type * as Types from './Types.js'

/** A decoded, unverified attestation. */
export type Decoded = {
  /** JWS protected header. */
  readonly header: { readonly alg?: unknown; readonly kid?: unknown; readonly typ?: unknown }
  /** Unverified claims. */
  readonly claims: Partial<Types.Claims> & Readonly<Record<string, unknown>>
  /** The signed bytes: `base64url(header) + '.' + base64url(claims)`. */
  readonly signingInput: Uint8Array
  /** Signature bytes. */
  readonly signature: Uint8Array
}

/**
 * The outcome of {@link verify}: `unavailable` when the issuer's keys could not be fetched,
 * which says nothing about the token.
 */
export type VerifyResult =
  | { readonly status: 'valid'; readonly claims: Types.Claims }
  | { readonly status: 'invalid' | 'unavailable'; readonly reason: string }

/**
 * Signs attestation claims as a compact JWS (EdDSA over Ed25519).
 *
 * For issuers. `keyId` should be the RFC 7638 thumbprint of the public key
 * published in the issuer's JSON Web Key Set.
 */
export async function sign(
  claims: Types.Claims,
  options: { readonly key: CryptoKey; readonly keyId: string },
): Promise<string> {
  const header = { alg: Constants.algorithm, kid: options.keyId, typ: Constants.tokenType }
  const input = `${encode(header)}.${encode(claims)}`
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    options.key,
    new TextEncoder().encode(input),
  )
  return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
}

/** Decodes an attestation without verifying it, or returns `undefined` if it is malformed. */
export function decode(token: string): Decoded | undefined {
  if (token.length > Constants.maxLength) return undefined
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined
  try {
    const header = JSON.parse(Base64.toString(parts[0]!))
    const claims = JSON.parse(Base64.toString(parts[1]!))
    if (!isObject(header) || !isObject(claims)) return undefined
    return {
      header,
      claims,
      signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      signature: Base64.toBytes(parts[2]!),
    }
  } catch {
    return undefined
  }
}

/**
 * Verifies an attestation's signature and claims.
 *
 * Checks the EdDSA algorithm and `typ`, the issuer, audience and type, and the
 * `iat` and `exp` times (with `clockTolerance`), then the signature with the
 * key `keyResolver` returns for the header's `kid`.
 */
export async function verify(token: string, options: verify.Options): Promise<VerifyResult> {
  assertTimes(options)
  const decoded = decode(token)
  if (!decoded) return invalid('The attestation is malformed.')
  const { header, claims } = decoded
  if (header.alg !== Constants.algorithm) return invalid('The attestation algorithm is not EdDSA.')
  if (header.typ !== Constants.tokenType) return invalid('The attestation type header is wrong.')
  if (typeof header.kid !== 'string' || header.kid === '')
    return invalid('The attestation has no key ID.')
  if (claims.iss !== options.issuer) return invalid('The attestation issuer is not trusted.')
  if (claims.type !== options.type) return invalid('The attestation type is not accepted.')
  if (claims.aud !== options.audience) return invalid('The attestation is for another audience.')
  if (typeof claims.sub !== 'string' || claims.sub === '')
    return invalid('The attestation has no subject.')
  if (claims.jti !== undefined && typeof claims.jti !== 'string')
    return invalid('The attestation ID is malformed.')
  if (!isTime(claims.iat) || !isTime(claims.exp))
    return invalid('The attestation times are malformed.')
  const now = options.now ?? Math.floor(Date.now() / 1_000)
  const tolerance = options.clockTolerance ?? Constants.clockTolerance
  if (claims.exp <= now - tolerance) return invalid('The attestation has expired.')
  if (claims.iat > now + tolerance) return invalid('The attestation was issued in the future.')
  if (options.maxAge !== undefined && now - claims.iat > options.maxAge + tolerance)
    return invalid('The attestation is too old.')

  let key: CryptoKey | undefined
  try {
    key = await options.keyResolver({ issuer: options.issuer, keyId: header.kid })
  } catch {
    // The issuer's keys are unreachable, which says nothing about the token.
    return { status: 'unavailable', reason: 'The attestation key could not be resolved.' }
  }
  if (!key) return invalid('No public key is available for the attestation key ID.')
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      decoded.signature as Uint8Array<ArrayBuffer>,
      decoded.signingInput as Uint8Array<ArrayBuffer>,
    )
  } catch {}
  if (!valid) return invalid('The attestation signature is invalid.')
  return { status: 'valid', claims: Object.freeze({ ...claims }) as Types.Claims }
}

export declare namespace verify {
  type Options = {
    /** Accepted attestation type, such as `email`. */
    readonly type: string
    /** Trusted issuer URL. */
    readonly issuer: string
    /** Origin the attestation must be bound to. */
    readonly audience: string
    /** Resolves the issuer's public key by key ID. */
    readonly keyResolver: Types.KeyResolver
    /** Oldest accepted `iat`, in seconds before now. Defaults to the attestation's own `exp`. */
    readonly maxAge?: number | undefined
    /** Clock tolerance in seconds. @default 60 */
    readonly clockTolerance?: number | undefined
    /** Current Unix time in seconds, for tests. */
    readonly now?: number | undefined
  }
}

/** Splits an `Identity-Attestation` header value into its attestations. */
export function parseHeader(value: string | null): readonly string[] {
  if (!value) return []
  return value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

function encode(value: unknown): string {
  return Base64.fromString(JSON.stringify(value), { pad: false, url: true })
}

function invalid(reason: string) {
  return { status: 'invalid', reason } as const
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Throws a `TypeError` unless `clockTolerance`, `maxAge` and `now` are each absent or a
 * non-negative integer of seconds: `NaN` or `Infinity` would turn the time checks off.
 * @internal
 */
export function assertTimes(options: {
  readonly clockTolerance?: number | undefined
  readonly maxAge?: number | undefined
  readonly now?: number | undefined
}): void {
  for (const [name, value] of [
    ['clockTolerance', options.clockTolerance],
    ['maxAge', options.maxAge],
    ['now', options.now],
  ] as const)
    if (value !== undefined && !isTime(value))
      throw new TypeError(`Attestation ${name} must be a non-negative integer of seconds.`)
}

function isTime(value: unknown): value is number {
  // Bounded by the largest time a Date holds, so every accepted time converts to a valid Date.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxTime
}

/** Latest time, in Unix seconds, that a JavaScript Date can represent. */
const maxTime = 8_640_000_000_000

/** Accepts https issuers, and http only on localhost for development. */
export function isIssuer(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}
