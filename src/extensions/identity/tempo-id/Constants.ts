/** Tempo ID values. */
export const Constants = {
  /** Identity type advertised in the 402's `Identity-Required` header. */
  type: 'tempo-id',
  /** Tempo ID in production: the issuer of every access token. */
  issuer: 'https://id.tempo.xyz',
  /** Seconds a DPoP proof is accepted after its `iat`. */
  proofMaxAge: 300,
  /** Seconds of clock skew allowed on token and proof times. */
  clockTolerance: 60,
} as const
