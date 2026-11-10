/** Status of a Persona inquiry. */
export type InquiryStatus =
  | 'created'
  | 'pending'
  | 'completed'
  | 'approved'
  | 'declined'
  | 'failed'
  | 'expired'
  | 'needs_review'

/** A payer with an accepted Persona inquiry. */
export type VerifiedInquiry = {
  /** Persona inquiry ID, such as `inq_…`. */
  readonly inquiryId: string
  /** Reference ID the inquiry was created with, which the check matched. */
  readonly referenceId: string
  /** Inquiry status, such as `approved`. */
  readonly status: InquiryStatus
  /** When the inquiry was decisioned, or completed if it was never decisioned. */
  readonly verifiedAt?: Date | undefined
}

/** A started Persona inquiry. */
export type StartedInquiry = {
  /** Persona inquiry ID, such as `inq_…`. */
  readonly inquiryId: string
  /** One-time link to Persona's hosted flow, for the person to complete KYC. */
  readonly url: string
}
