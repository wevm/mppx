/**
 * Email OTP identity: an issuer emails a one-time code and signs an `email` attestation
 * (`mppx/extensions/identity/attestation`) the client sends in `Identity-Attestation`.
 * For your own identity system, use `Identity.from` from `mppx/identity`.
 */

/** Client helpers that verify an email address with a one-time code. */
export * as Client from './client/index.js'
/** Server helpers that require a verified email address. */
export * as Server from './server/index.js'
export * from './Constants.js'
export type * from './Types.js'
