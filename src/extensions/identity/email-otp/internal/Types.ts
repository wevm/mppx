import type { MaybePromise } from '../../../../internal/types.js'

/**
 * Claims of an MPP identity attestation.
 *
 * An issuer signs these after checking one fact about the subject, such as
 * control of an email address. `aud` binds the attestation to the origin of
 * the server it is presented to, so that server cannot replay it elsewhere.
 */
export type Claims = {
  /** Issuer URL. */
  iss: string
  /** Origin of the server the attestation is for, such as `https://api.example`. */
  aud: string
  /** Attested subject, such as an email address. */
  sub: string
  /** Attestation type, such as `email`. */
  type: string
  /** Issued-at time, in Unix seconds. */
  iat: number
  /** Expiry time, in Unix seconds. */
  exp: number
  /** Unique attestation identifier. */
  jti?: string | undefined
}

/**
 * Resolves the issuer's public key for an attestation's `kid`. Returns
 * `undefined` for an unknown or malformed `kid`, and throws only when the keys
 * cannot be fetched: a throw answers the request with 503.
 */
export type KeyResolver = (parameters: {
  /** Issuer URL the attestation claims. */
  issuer: string
  /** Key identifier from the JWS header. */
  keyId: string
}) => MaybePromise<CryptoKey | undefined>

/** An attestation a route requires, as listed in `Identity-Attestation-Required`. */
export type Requirement = {
  /** Attestation type, such as `email`. */
  type: string
  /** Issuer URL the route trusts, or where to obtain the identity. Absent for a server's own identity system without one. */
  issuer?: string | undefined
}

/** A verified attestation. */
export type Verified = {
  /** Verified claims. */
  claims: Claims
}
