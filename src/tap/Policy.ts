import type * as Attestation from '../attestation/Types.js'
import { Constants } from './Constants.js'
import type * as Types from './Types.js'

/** Creates a policy that accepts only TAP signatures with the requested commerce intent. */
export function requireIntent(intent: Types.VerifiedRequest['intent']): Attestation.RequestPolicy {
  return ({ evidence }) => {
    const accepted = evidence.some((entry) => {
      if (entry.protocol !== Constants.protocol) return false
      return (entry as Types.Evidence).value.intent === intent
    })
    return accepted
      ? { allow: true }
      : { allow: false, reason: `A TAP ${intent} intent signature is required.` }
  }
}
