/** Identity attestations: issuer-signed tokens a server requires and a client presents. */
export * as Attestation from './attestation/index.js'
/** Email address verification with a one-time code. */
export * as EmailOtp from './email-otp/index.js'
/** Link agent identity: attestation tokens and Link-signed claims. */
export * as Link from './link/index.js'
/** Persona KYC: a payment check that requires an approved Persona inquiry. */
export * as Persona from './persona/index.js'
/** Client and server adapters for the TAP agent-recognition signature profile. */
export * as Tap from './tap/index.js'
/** Client and server adapters for the Web Bot Auth HTTPS-directory profile. */
export * as WebBotAuth from './web-bot-auth/index.js'
/** World ID: agents approved by a World ID-verified human, through World IdP (OpenID Connect). */
export * as World from './world/index.js'
export * from './Constants.js'
export type * from './Types.js'
