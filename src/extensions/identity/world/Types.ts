/** A human verified with World ID through World IdP. */
export type VerifiedHuman = {
  /** World IdP issuer. */
  readonly issuer: string
  /**
   * Anonymous, pairwise account identifier: stable for one person across sessions within your
   * application's sector, and different in other sectors. Store it together with `issuer`.
   */
  readonly subject: string
  /** Achieved authentication class, such as `https://world.org/oidc/acr/orb`. */
  readonly acr: string
  /** Authentication methods, such as `['pop']` for a World ID proof. */
  readonly amr: readonly string[]
  /** When the person authenticated with World ID. */
  readonly authTime: Date
  /** When the session ends. */
  readonly expiresAt: Date
}

/**
 * A device attempt's state, sent base64url-encoded in the `World-Id-Device` header of
 * every answer to a `World-Id-Poll` request.
 */
export type Device =
  | {
      /** Waiting for the person to approve in World App. */
      readonly status: 'pending'
      /** Opaque attempt token to poll with. */
      readonly attempt: string
      /** Code the person confirms on the approval page. */
      readonly user_code: string
      /** Approval page. */
      readonly verification_uri: string
      /** Approval page with the code filled in. */
      readonly verification_uri_complete?: string | undefined
      /** Seconds until the attempt expires. */
      readonly expires_in: number
      /** Seconds to wait between polls. */
      readonly interval: number
    }
  | {
      /** Approved: send `session` in the `World-Id` header. */
      readonly status: 'approved'
      /** Opaque session token. */
      readonly session: string
      /** Seconds until the session expires. */
      readonly expires_in: number
    }
  | {
      /** The person declined, the attempt expired, or World ID did not qualify: start over. */
      readonly status: 'denied' | 'expired'
    }
