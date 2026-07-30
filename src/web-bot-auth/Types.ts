import type * as Attestation from '../attestation/Types.js'
import type { Constants } from './Constants.js'

/** Verified Web Bot Auth request signature. */
export type VerifiedRequest = {
  /** Public-key thumbprint advertised by the bot. */
  keyId: string
  /** HTTPS directory origin carried in the signed `Signature-Agent` header. */
  signatureAgent: string
  /** Signature nonce supplied by the bot. */
  nonce: string
}

/** Web Bot Auth evidence made available to generic attestation policies. */
export type Evidence = Attestation.Evidence<typeof Constants.protocol, VerifiedRequest>
