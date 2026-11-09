/**
 * MPP identity attestations: a compact EdDSA JWS an issuer signs after checking one fact about
 * the subject (such as an email address or phone number), bound to the origin it is presented
 * to and sent in `Identity-Attestation`.
 *
 * Servers require one with `Server.verifier`, clients present and obtain them with
 * `Client.prover`, and issuers sign them with `sign` and publish their keys as a JSON Web Key
 * Set that `Jwks.resolver` reads.
 */

/** Client prover that presents and obtains attestations. */
export * as Client from './client/index.js'
/** Issuer JSON Web Key Set resolver. */
export * as Jwks from './Jwks.js'
/** Server verifier that requires an attestation. */
export * as Server from './server/index.js'
export { decode, sign, verify } from './Token.js'
export type { Decoded, VerifyResult } from './Token.js'
export * from './Constants.js'
export type * from './Types.js'
