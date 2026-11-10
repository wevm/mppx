import type { MaybePromise } from '../../../internal/types.js'

/** Link agent identity values, as Link's Agent Identity SDK and Link CLI use them. */
export const Constants = {
  /** Link's issuer, the only one the Agent Identity SDK trusts. */
  issuer: 'https://api.link.com',
  /** `Authorization` scheme of an Agent Attestation Token (RFC 9577). */
  attestationScheme: 'PrivateToken',
  /** Request header carrying an identity presentation, and its `WWW-Authenticate` scheme. */
  presentationHeader: 'Identity-Presentation',
  /** `type` of the problem body of a claims challenge. */
  claimsRequiredType: 'urn:stripe:link:claims-required',
  /** Presentation format of a claims challenge. */
  format: 'dc+sd-jwt',
  /** Seconds a claims challenge's nonce is accepted for. */
  nonceTtl: 300,
} as const

/** One failure of a Link verification, as `@stripe/agent-identity` reports it. */
export type Failure = { readonly code: string; readonly message: string }

/** Verifies Link Agent Attestation Tokens: a `LinkVerifier`, or `Link.Server.tokenVerifier()`. */
export type AttestationVerifier = Pick<LinkVerifier, 'attestationChallenge' | 'verifyAttestation'>

/** Verifies Link identity presentations: a `LinkVerifier`, or `Link.Server.presentationVerifier()`. */
export type ClaimsVerifier = Pick<LinkVerifier, 'verifyClaims'>

/**
 * The parts of `LinkVerifier` from `@stripe/agent-identity` the verifiers use. Pass one
 * `new LinkVerifier({ origin })` per process, so every request shares its issuer key cache.
 */
export type LinkVerifier = {
  attestationChallenge(): Promise<{ wwwAuthenticate: string[] }>
  verifyAttestation(
    authorization: string | null | undefined,
  ): Promise<
    | { valid: true; issuer: string; tokenKeyId: string; bindingMode?: 'bearer' }
    | { valid: false; failures: readonly Failure[] }
  >
  verifyClaims(
    presentation: string | null | undefined,
    options: { nonce: string; requiredClaims: string[] },
  ): Promise<
    | {
        valid: true
        issuer: string
        vct: string
        claims: Record<string, unknown>
        holderKeyThumbprint: string
      }
    | { valid: false; failures: readonly Failure[] }
  >
}

/** A verified Link Agent Attestation Token: Link vouches for the agent, and says nothing else. */
export type VerifiedAttestation = {
  /** Issuer whose key signed the token. */
  readonly issuer: string
  /** base64url of the token's `token_key_id`. */
  readonly tokenKeyId: string
}

/** Claims Link signed and the holder disclosed to this server. */
export type VerifiedClaims = {
  /** Issuer of the credential. */
  readonly issuer: string
  /** Credential type (`vct`). */
  readonly vct: string
  /** The disclosed claims, by name. */
  readonly claims: Readonly<Record<string, unknown>>
  /** RFC 7638 thumbprint of the holder key that signed the presentation. */
  readonly holderKeyThumbprint: string
  /** The verified email address, lowercased, when `email` and a true `email_verified` were disclosed. */
  readonly email?: string | undefined
}

/** A claims challenge: the problem body of a 401 with `WWW-Authenticate: Identity-Presentation`. */
export type ClaimsChallenge = {
  readonly type: 'urn:stripe:link:claims-required'
  /** Origin the presentation must be bound to. */
  readonly aud: string
  /** Nonce the presentation must sign. */
  readonly nonce: string
  /** Claims to disclose. */
  readonly claims: readonly string[]
  /** Why the server asks, for the person whose claims they are. */
  readonly purpose?: string | undefined
  readonly formats: readonly string[]
  readonly trusted_issuers: readonly string[]
}

/** Creates a presentation for a claims challenge, such as with `link-cli identity credentials present`. */
export type Present = (parameters: {
  /** Origin the presentation is for: always the request's own origin. */
  audience: string
  /** Nonce from the challenge. */
  nonce: string
  /** Claims to disclose. */
  claims: readonly string[]
  /** Why the server asks. */
  purpose?: string | undefined
}) => MaybePromise<string | undefined>
