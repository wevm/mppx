/** Capabilities an attestation protocol can cryptographically establish. */
export const Capabilities = {
  /** Identifies the automated client that signed the request. */
  agentIdentity: 'agent-identity',
  /** Establishes that the client expressed a protocol-defined commerce intent. */
  commerceIntent: 'commerce-intent',
  /** Binds a unique signature nonce to this request. */
  replayProtection: 'replay-protection',
  /** Binds signature evidence to selected HTTP request components. */
  requestBinding: 'request-binding',
} as const

/** RFC 9421 signature algorithms supported by request attestation. */
export const Algorithms = {
  /** EdDSA using the Ed25519 curve. */
  ed25519: 'ed25519',
  /** RSASSA-PSS using SHA-512 and a 64-byte salt. */
  rsaPssSha512: 'rsa-pss-sha512',
} as const

/** HTTP headers defined by RFC 9421 for request-attestation signatures. */
export const Headers = {
  /** Carries the RFC 9421 signature bytes. */
  signature: 'Signature',
  /** Carries the RFC 9421 covered components and signature parameters. */
  signatureInput: 'Signature-Input',
} as const
