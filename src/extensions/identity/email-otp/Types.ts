/** A verified email address. */
export type VerifiedEmail = {
  /** The email address the issuer sent a one-time code to, lowercased. */
  readonly email: string
  /** Issuer URL. */
  readonly issuer: string
  /** When the attestation expires. */
  readonly expiresAt: Date
  /** Attestation identifier (`jti`), if the issuer set one. */
  readonly id?: string | undefined
}
