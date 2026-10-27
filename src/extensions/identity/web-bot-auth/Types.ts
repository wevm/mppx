/** Verified Web Bot Auth HTTPS-directory profile request signature. */
export type VerifiedRequest = {
  /** Public-key thumbprint advertised by the bot. */
  keyId: string
  /** HTTPS directory origin carried in the signed `Signature-Agent` header. */
  signatureAgent: string
  /** Signature nonce supplied by the bot. */
  nonce: string
}
