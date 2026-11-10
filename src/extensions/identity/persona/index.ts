/**
 * Persona KYC identity: start a Persona inquiry for a person's wallet, then require an approved
 * inquiry on paid requests, looked up with your Persona API key by the inquiry's reference ID.
 */

/** Server helpers that start Persona inquiries and require a Persona-verified payer. */
export * as Server from './server/index.js'
export * from './Constants.js'
export { did } from './Did.js'
export type * from './Types.js'
