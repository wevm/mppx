import type * as Attestation from '../attestation/Types.js'
import type { Constants } from './Constants.js'

/** Verified TAP agent-recognition signature. */
export type VerifiedRequest = {
  /** Key identity recognized by the merchant's TAP trust store. */
  keyId: string
  /** Session nonce bound to the TAP message signature. */
  nonce: string
  /** TAP interaction type established by the signature tag. */
  intent: (typeof Constants.intents)[keyof typeof Constants.intents]
}

/** TAP evidence made available to generic attestation policies. */
export type Evidence = Attestation.Evidence<typeof Constants.protocol, VerifiedRequest>
