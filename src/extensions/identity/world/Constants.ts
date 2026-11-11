/** World ID values for the World IdP (OpenID Connect) device flow. */
export const Constants = {
  /** World IdP issuer. */
  issuer: 'https://auth.world.org',
  /** World IdP sandbox issuer, for testing with sandbox client credentials. */
  sandboxIssuer: 'https://sandbox.auth.world.org',
  /** Request header carrying the session the server issued after World ID approval. */
  header: 'World-Id',
  /**
   * Request header of the prover's out-of-band device-flow calls: `start`, or an attempt token
   * to poll. A request carrying it never reaches the route's handler.
   */
  pollHeader: 'World-Id-Poll',
  /** Response header asking for World ID: `device`. */
  requiredHeader: 'World-Id-Required',
  /** Response header carrying the device attempt's state, base64url-encoded JSON. */
  deviceHeader: 'World-Id-Device',
  /** World IdP authentication classes (`acr`). */
  acr: {
    /** Orb-verified account. */
    orb: 'https://world.org/oidc/acr/orb',
    /** Orb-verified account with a Face Auth check during this authentication. */
    orbFace: 'https://world.org/oidc/acr/orb-face',
    /** Selfie Check-verified account. */
    selfie: 'https://world.org/oidc/acr/selfie',
    /** Selfie Check-verified account with a Face Auth check during this authentication. */
    selfieFace: 'https://world.org/oidc/acr/selfie-face',
  },
  /** Default lifetime, in seconds, of a session after World ID approval. */
  sessionTtl: 60 * 60,
  /** Default device-flow polling interval, in seconds, when World IdP sets none. */
  interval: 5,
  /** Allowed clock skew, in seconds, for ID token times. */
  clockTolerance: 60,
  /** Largest accepted `World-Id` or `World-Id-Poll` header value, in characters. */
  maxLength: 4096,
  /** World IdP integration guides. */
  docs: 'https://auth.world.org/docs/guides/getting-started',
} as const
