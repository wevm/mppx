import { Constants as AttestationConstants } from '../attestation/Constants.js'

/** Email OTP attestation values. Values every attestation shares are in `Attestation.Constants`. */
export const Constants = {
  /** @deprecated Use `Attestation.Constants.header`. */
  header: AttestationConstants.header,
  /** @deprecated Use `Attestation.Constants.requiredHeader`. */
  requiredHeader: AttestationConstants.requiredHeader,
  /** Attestation type for a verified email address. */
  type: 'email',
  /** Issuer path that emails a one-time code. */
  otpPath: '/email/otp',
  /** Issuer path that exchanges a one-time code for an attestation. */
  verifyPath: '/email/verify',
  /** Times the prover asks for a code before giving up. */
  codeAttempts: 3,
} as const
