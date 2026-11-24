/** RFC 9421 signature algorithms supported by HTTP message signatures. */
export const Algorithms = {
  /** EdDSA using the Ed25519 curve. */
  ed25519: 'ed25519',
  /** ECDSA using the P-256 curve and SHA-256. */
  ecdsaP256Sha256: 'ecdsa-p256-sha256',
  /** ECDSA using the P-384 curve and SHA-384. */
  ecdsaP384Sha384: 'ecdsa-p384-sha384',
  /** RSASSA-PSS using SHA-512 and a 64-byte salt. */
  rsaPssSha512: 'rsa-pss-sha512',
} as const

/** HTTP headers defined by RFC 9421 for identity signatures. */
export const Headers = {
  /** Carries the RFC 9421 signature bytes. */
  signature: 'Signature',
  /** Carries the RFC 9421 covered components and signature parameters. */
  signatureInput: 'Signature-Input',
} as const
