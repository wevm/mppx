import { Constants as HttpMessageSignature } from '../attestation/internal/HttpMessageSignature.js'

/** Web Bot Auth values required for its RFC 9421 bot-identity signature profile. */
export const Constants = {
  /** Stable identifier for Web Bot Auth evidence and signers. */
  protocol: 'web-bot-auth',
  /** RFC 9421 signature label used when no label is configured. */
  label: 'webbot',
  /** Tag identifying a Web Bot Auth request signature. */
  tag: 'web-bot-auth',
  /** Structured HTTP header linking a bot signature to its HTTPS directory origin. */
  signatureAgentHeader: 'Signature-Agent',
  /** Maximum and default lifetime, in seconds, for a bot request signature. */
  signatureLifetime: 60,
  /** HTTP components every Web Bot Auth signature must cover. */
  requiredComponents: [
    HttpMessageSignature.components.authority,
    HttpMessageSignature.components.signatureAgent,
  ],
} as const
