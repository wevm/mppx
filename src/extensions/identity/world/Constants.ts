/**
 * World ID attestation values. Values every attestation shares are in `Attestation.Constants`.
 *
 * A World ID issuer is an external service holding a confidential World IdP client. It runs World
 * IdP's OpenID Connect device flow for the agent's human, verifies the ID token, and signs an
 * `Identity-Attestation` of type `world-id` bound to the server's origin. Its API:
 *
 * - `POST {issuer}/world/device` with `{ "audience": "<origin>" }`: starts an attempt and answers
 *   `{ id, user_code, verification_uri, verification_uri_complete?, expires_in, interval }`.
 * - `POST {issuer}/world/token` with `{ "id": "<attempt>" }`: answers `{ attestation, expires_at }`
 *   once approved, or 400 with `error` set to `authorization_pending`, `slow_down`,
 *   `access_denied` or `expired_token` (RFC 8628). 429 and 5xx mean try again later.
 * - `GET {issuer}/.well-known/jwks.json`: its attestation keys.
 */
export const Constants = {
  /** Attestation type for a human verified with World ID. */
  type: 'world-id',
  /** Issuer path that starts a device attempt. */
  devicePath: '/world/device',
  /** Issuer path that polls a device attempt for its attestation. */
  tokenPath: '/world/token',
  /** World IdP authentication classes, which an issuer puts in the attestation's `acr` claim. */
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
  /** Polling interval, in seconds, when the issuer sets none (RFC 8628). */
  interval: 5,
  /** Seconds `slow_down` adds to the polling interval (RFC 8628). */
  slowDown: 5,
  /** Seconds a client waits after a failed or declined attempt before starting another for the same origin. */
  retryDelay: 60,
  /** Milliseconds a client waits for each issuer call. */
  requestTimeout: 10_000,
} as const
