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
