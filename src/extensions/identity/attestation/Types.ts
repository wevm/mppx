import type { MaybePromise } from '../../../internal/types.js'

/**
 * Claims of an MPP identity attestation.
 *
 * An issuer signs these after checking one fact about the subject, such as
 * control of an email address. `aud` binds the attestation to the origin of
 * the server it is presented to, so that server cannot replay it elsewhere.
 */
export type Claims = {
  /** Issuer URL. */
  readonly iss: string
  /** Origin of the server the attestation is for, such as `https://api.example`. */
  readonly aud: string
  /**
   * Attested subject: an email address or phone number, or the provider's stable identifier for
   * an account (such as a GitHub user ID), never a handle that can change.
   */
  readonly sub: string
  /**
   * Attestation type: any structured-field token the issuer and server agree on, such as
   * `email`, `phone`, `github`, `x` or `tempo-id`. One attestation states one fact; an issuer
   * that knows several of a user's accounts signs one attestation of each type.
   */
  readonly type: string
  /** Issued-at time, in Unix seconds. */
  readonly iat: number
  /** Expiry time, in Unix seconds. */
  readonly exp: number
  /** Unique attestation identifier. */
  readonly jti?: string | undefined
  /**
   * The issuer's identifier for the user behind the subject, the same across that issuer's
   * attestations of every type, so a server can tell that an `email` and a `github`
   * attestation from one issuer name the same user.
   */
  readonly uid?: string | undefined
  /**
   * Confirmation (RFC 7800): what the attestation is bound to, such as the key that must sign
   * each request (`jkt`, an RFC 7638 thumbprint) or the account that pays (`addr`).
   */
  readonly cnf?: Confirmation | undefined
} & Readonly<Record<string, unknown>>

/**
 * What an attestation is bound to (RFC 7800 `cnf`). Issuers may add other members; a server
 * enforces the ones it understands.
 */
export type Confirmation = {
  /** RFC 7638 thumbprint of the key that must sign each request. */
  readonly jkt?: string | undefined
  /** Address of the account that must pay, such as a Tempo Account. */
  readonly addr?: string | undefined
} & Readonly<Record<string, unknown>>

/**
 * Resolves the issuer's public key for an attestation's `kid`. Returns
 * `undefined` for an unknown or malformed `kid`, and throws only when the keys
 * cannot be fetched: a throw answers the request with 503 (`unavailable`).
 */
export type KeyResolver = (parameters: {
  /** Issuer URL the attestation claims. */
  readonly issuer: string
  /** Key identifier from the JWS header. */
  readonly keyId: string
}) => MaybePromise<CryptoKey | undefined>

/** An attestation a route requires, as listed in `Identity-Attestation-Required`. */
export type Requirement = {
  /** Attestation type, such as `email`. */
  readonly type: string
  /** Issuer URL the route trusts, or where to obtain the identity. Absent for a server's own identity system without one. */
  readonly issuer?: string | undefined
}

/** A verified attestation. */
export type Verified = {
  /** Verified claims. */
  readonly claims: Claims
}
