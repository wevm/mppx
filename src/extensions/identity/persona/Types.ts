/** A payer with an accepted Persona inquiry. */
export type VerifiedInquiry = {
  /** Persona inquiry ID, such as `inq_…`. */
  readonly inquiryId: string
  /** Reference ID the inquiry was created with, which the check matched against the payer. */
  readonly referenceId: string
  /** Inquiry status, such as `approved`. */
  readonly status: string
  /** When the inquiry was decisioned, or completed if it was never decisioned. */
  readonly verifiedAt?: Date | undefined
}
