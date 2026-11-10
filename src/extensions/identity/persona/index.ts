/**
 * Persona KYC identity: a payment check that requires the payer to have an approved
 * Persona inquiry, looked up with your Persona API key by the inquiry's reference ID.
 */

/** Server helpers that require a Persona-verified payer. */
export * as Server from './server/index.js'
export * from './Constants.js'
export type * from './Types.js'
