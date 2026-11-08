/** Email OTP attestation values. */
export const Constants = {
  /** Request header carrying the email attestation. */
  header: 'Identity-Attestation',
  /** Response header naming the issuer to get an attestation from. */
  requiredHeader: 'Identity-Attestation-Required',
  /** Attestation type for a verified email address. */
  type: 'email',
  /** Issuer path that emails a one-time code. */
  otpPath: '/email/otp',
  /** Issuer path that exchanges a one-time code for an attestation. */
  verifyPath: '/email/verify',
  /** Times the prover asks for a code before giving up. */
  codeAttempts: 3,
} as const
