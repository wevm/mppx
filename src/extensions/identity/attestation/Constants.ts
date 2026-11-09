/** Values shared by every MPP identity attestation. */
export const Constants = {
  /** Request header carrying one or more attestations, separated by commas. */
  header: 'Identity-Attestation',
  /** Response header listing the attestations a route requires, as a structured list. */
  requiredHeader: 'Identity-Attestation-Required',
  /**
   * Response header of a 402 listing attestations the route accepts for a better offer, such as a
   * lower price, as a structured list in the format of {@link requiredHeader}.
   */
  offeredHeader: 'Identity-Attestation-Offered',
  /** JWS `typ` header of an attestation. */
  tokenType: 'mpp-attestation+jwt',
  /** JWS algorithm of an attestation: EdDSA over Ed25519. */
  algorithm: 'EdDSA',
  /** Path of the issuer's JSON Web Key Set, relative to the issuer URL. */
  jwksPath: '/.well-known/jwks.json',
  /** Clock tolerance, in seconds, applied to `iat` and `exp`. */
  clockTolerance: 60,
  /**
   * Seconds before expiry at which a client stops sending an attestation on unpaid attempts and
   * replaces it, capped at half the attestation's lifetime.
   */
  refreshMargin: 300,
  /** Longest attestation accepted, in characters. */
  maxLength: 8_192,
} as const
