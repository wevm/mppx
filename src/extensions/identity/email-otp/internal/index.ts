/**
 * The email attestation format, internal to email-otp: a compact EdDSA JWS the
 * issuer signs, its JSON Web Key Set lookup, and the `Identity-Attestation`
 * headers. Not exported from the package.
 */
export * as Client from './Prover.js'
export * as Jwks from './Jwks.js'
export * as Server from './Verifier.js'
export { decode, parseHeader, sign, verify } from './Attestation.js'
export * from './Constants.js'
export type * from './Types.js'
