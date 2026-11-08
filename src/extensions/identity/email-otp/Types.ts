/** A verified email address. */
export type VerifiedEmail = {
  /** The email address the issuer sent a one-time code to, lowercased. */
  email: string
  /** Issuer URL. */
  issuer: string
  /** When the attestation expires. */
  expiresAt: Date
  /** Attestation identifier (`jti`), if the issuer set one. */
  id?: string | undefined
}
