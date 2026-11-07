/**
 * Email OTP identity: an issuer emails a one-time code and signs an attestation
 * the client sends in `Identity-Attestation`.
 *
 * Limitation: the attestation format, its key lookup and the
 * `Identity-Attestation` headers are internal to this extension. Another
 * attestation type (phone, KYC) needs its own extension, or this one made
 * generic, once a second issuer exists. For your own identity system, use
 * `Identity.from` from `mppx/identity`.
 */
/** Client helpers that verify an email address with a one-time code. */
export * as Client from './client/index.js'
/** Server helpers that require a verified email address. */
export * as Server from './server/index.js'
export * from './Constants.js'
export type * from './Types.js'
