import type * as Challenge from '../Challenge.js'

/** Context supplied before the CLI creates a payment credential. */
export type Context = Readonly<{
  challenge: Challenge.Challenge
  /** Method-specific context that will be supplied to credential creation. */
  credentialContext?: unknown
}>

/** Result of preparing a selected payment. */
export type Result = Readonly<{
  /** Replaces the method-specific context supplied to credential creation. */
  credentialContext?: unknown
}>

/** Method-agnostic CLI lifecycle hooks. */
export type Extension = Readonly<{
  /** Runs after challenge selection and confirmation, immediately before credential creation. */
  preparePayment?(context: Context): Result | void | Promise<Result | void>
}>

/** Defines an Mppx CLI extension. */
export function from(extension: Extension): Extension {
  return extension
}
