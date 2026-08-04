import { Constants as HttpMessageSignature } from '../attestation/internal/HttpMessageSignature.js'

/** Web Bot Auth values for the supported HTTPS-directory signature profile. */
export const Constants = {
  /** Stable identifier for Web Bot Auth signers and replay storage. */
  protocol: 'web-bot-auth',
  /** Web Bot Auth discovery type supported by this adapter. */
  discoveryType: 'directory',
  /** RFC 9421 signature label used when no label is configured. */
  label: 'webbot',
  /** Tag identifying a Web Bot Auth request signature. */
  tag: 'web-bot-auth',
  /** Structured HTTP header linking a bot signature to its HTTPS directory origin. */
  signatureAgentHeader: 'Signature-Agent',
  /** Default lifetime, in seconds, for a bot request signature. */
  defaultSignatureLifetime: 60,
  /** Default verifier limit, following the draft's recommended 24-hour maximum. */
  defaultMaximumSignatureLifetime: 24 * 60 * 60,
  /** HTTP components required by this directory profile. */
  requiredComponents: [
    HttpMessageSignature.components.authority,
    HttpMessageSignature.components.signatureAgent,
  ],
} as const
