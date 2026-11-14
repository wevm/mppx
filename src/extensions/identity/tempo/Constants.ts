/** Tempo ID values. */
export const Constants = {
  /** Identity type advertised in the 402's `Identity-Required` header. */
  type: 'tempo-id',
  /** Tempo ID in production: the issuer of every access token. */
  issuer: 'https://id.tempo.xyz',
  /** Path, relative to a Tempo ID attestation issuer's URL, that exchanges a token for an attestation. */
  attestPath: '/tempo-id/attest',
  /** Attestation types a Tempo ID attestation issuer signs: the user's Tempo ID and verified email. */
  attestationTypes: ['tempo-id', 'email'] as readonly ('tempo-id' | 'email')[],
  /** Header that carries the user's ID token, for their email address. */
  idTokenHeader: 'Tempo-Id-Token',
  /** Seconds a DPoP proof is accepted after its `iat`. */
  proofMaxAge: 300,
  /** Seconds of clock skew allowed on token and proof times. */
  clockTolerance: 60,
} as const
