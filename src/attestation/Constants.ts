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
