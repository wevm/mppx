import type * as Identity from '../../../identity/Types.js'
import type { VerificationResult } from './HttpMessageSignature.js'

/** Maps a non-verified HTTP message signature result to an identity verification. */
export function fromSignature(
  result: Exclude<VerificationResult, { status: 'verified' }>,
): Exclude<Identity.Verification, { status: 'valid' }> {
  if (result.status === 'absent') return { status: 'missing' }
  if (result.status === 'invalid') return { status: 'invalid', reason: result.reason }
  // The signature was presented but its key is not trusted or available.
  return { status: 'invalid', code: 403, reason: result.reason }
}
