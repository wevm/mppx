import type * as Challenge from '../../Challenge.js'
import type * as Method from '../../Method.js'

/** Checks a client method adds to the client's spending options, without changing its shape. */
export type Hooks = {
  /**
   * Throws when the method's own policy refuses `challenge`, so authorization and funders never
   * run for an offer the method would not sign.
   */
  assert?: ((challenge: Challenge.Challenge) => void) | undefined
  /**
   * Whether a credential for `challenge` resumes a payment the method already made, such as an
   * outstanding Zone withdrawal, which the spending options counted when it started.
   */
  resumes?: ((challenge: Challenge.Challenge) => boolean) | undefined
}

/** How the client's spending options constrain one credential the method creates. */
export type Constraints = Readonly<{
  /** The limit a refusal names: `maxPayment` when it is set, else `budget`. */
  limit: 'maxPayment' | 'budget'
  /**
   * Whether the credential may only resume the payment {@link Hooks.resumes} found. Its spending
   * checks were skipped, so a new payment must not start.
   */
  resume: boolean
}>

const hooks = new WeakMap<Method.AnyClient, Hooks>()
const constraints = new WeakMap<object, Constraints>()

/** Registers a method's spending hooks. */
export function register<const method extends Method.AnyClient>(
  method: method,
  value: Hooks,
): method {
  hooks.set(method, value)
  return method
}

/** Returns a method's spending hooks, when it registered any. */
export function get(method: Method.AnyClient): Hooks | undefined {
  return hooks.get(method)
}

/** Marks credential parameters as created under the client's spending options. */
export function constrain(parameters: object, value: Constraints): void {
  constraints.set(parameters, value)
}

/** Returns the spending constraints of credential parameters, when spending options apply. */
export function of(parameters: object): Constraints | undefined {
  return constraints.get(parameters)
}
