import { Constants as HttpMessageSignature } from '../attestation/internal/HttpMessageSignature.js'

/** TAP values required for its RFC 9421 agent-recognition signature profile. */
export const Constants = {
  /** Stable identifier for Trusted Agent Protocol signers and replay storage. */
  protocol: 'tap',
  /** RFC 9421 signature label used when no label is configured. */
  label: 'tap',
  /** Maximum lifetime, in seconds, permitted by TAP for an agent signature. */
  maximumSignatureLifetime: 8 * 60,
  /** Default lifetime, in seconds, applied to TAP agent signatures. */
  defaultSignatureLifetime: 8 * 60,
  /** TAP tags that identify the signed interaction's intent. */
  tags: {
    /** Tag for an agent browsing or discovering a merchant. */
    browse: 'agent-browser-auth',
    /** Tag for an agent executing a payment-related interaction. */
    payment: 'agent-payer-auth',
  },
  /** Commerce intents represented by TAP signature tags. */
  intents: {
    /** An agent discovery or browsing interaction. */
    browse: 'browse',
    /** An agent payment interaction. */
    payment: 'payment',
  },
  /** HTTP components every TAP agent signature must cover. */
  requiredComponents: [
    HttpMessageSignature.components.authority,
    HttpMessageSignature.components.path,
  ],
} as const
