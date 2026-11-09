import type * as Identity from '../../../identity/Types.js'
import type { VerificationResult } from './HttpMessageSignature.js'

/** The identity status of each non-verified HTTP message signature result. */
const statuses = {
  absent: 'missing',
  invalid: 'invalid',
  // The signature was presented, but its key is not trusted or could not be resolved.
  unverified: 'forbidden',
} as const satisfies Record<
  Exclude<VerificationResult, { status: 'verified' }>['status'],
  Identity.RejectionStatus
>

/** Maps a non-verified HTTP message signature result to an identity verification. */
export function fromSignature(
  result: Exclude<VerificationResult, { status: 'verified' }>,
): Exclude<Identity.Verification, { status: 'valid' }> {
  if (result.status === 'absent') return { status: statuses.absent }
  return { status: statuses[result.status], reason: result.reason }
}
