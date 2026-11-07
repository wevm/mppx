/** Values shared by every MPP identity attestation. */
export const Constants = {
  /** Request header carrying one or more attestations, separated by commas. */
  header: 'Identity-Attestation',
  /** Response header listing the attestations a route requires, as a structured list. */
  requiredHeader: 'Identity-Attestation-Required',
  /** JWS `typ` header of an attestation. */
  tokenType: 'mpp-attestation+jwt',
  /** JWS algorithm of an attestation: EdDSA over Ed25519. */
  algorithm: 'EdDSA',
  /** Path of the issuer's JSON Web Key Set, relative to the issuer URL. */
  jwksPath: '/.well-known/jwks.json',
  /** Clock tolerance, in seconds, applied to `iat` and `exp`. */
  clockTolerance: 60,
  /** Longest attestation accepted, in characters. */
  maxLength: 8_192,
} as const
