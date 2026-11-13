/** A human verified with World ID, as a World ID issuer attests. */
export type VerifiedHuman = {
  /** Issuer URL. */
  readonly issuer: string
  /**
   * The issuer's identifier for the human. It is pseudonymous; whether it differs between
   * servers depends on the issuer. Store it together with `issuer`.
   */
  readonly subject: string
  /** World IdP authentication class, such as `https://world.org/oidc/acr/orb`, if the issuer set one. */
  readonly acr?: string | undefined
  /** When the attestation expires. */
  readonly expiresAt: Date
  /** Attestation identifier (`jti`), if the issuer set one. */
  readonly id?: string | undefined
}

/** A device attempt the issuer started: what to show the human. */
export type Device = {
  /** Attempt identifier to poll with. */
  readonly id: string
  /** Code the human confirms on the approval page. */
  readonly userCode: string
  /** Approval page. */
  readonly verificationUri: string
  /** Approval page with the code filled in, if the issuer provides one. */
  readonly verificationUriComplete?: string | undefined
  /** When the attempt expires. */
  readonly expiresAt: Date
  /** Seconds to wait between polls. */
  readonly interval: number
}

/** One poll of a device attempt. */
export type Poll =
  /** Approved: the attestation for the audience the attempt was started for. */
  | { readonly status: 'approved'; readonly attestation: string; readonly expiresAt: Date }
  /** Not approved yet. */
  | { readonly status: 'pending' }
  /** Polling too fast: add `Constants.slowDown` seconds to the interval. */
  | { readonly status: 'slow_down' }
  /** The issuer could not answer (429, 5xx, timeout or network error): poll again later. */
  | { readonly status: 'unavailable' }
