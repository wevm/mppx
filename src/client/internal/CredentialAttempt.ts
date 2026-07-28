import type * as Challenge from '../../Challenge.js'
import type { MaybePromise } from '../../internal/types.js'

const controllers = new WeakMap<object, Controller>()

export type Outcome = {
  challenges?: readonly Challenge.Challenge[] | undefined
  response?: Response | undefined
  status: 'accepted' | 'pending' | 'rejected'
}

export type Controller = {
  /** Re-runs method preparation when serialized state changed before signing. */
  prepare: () => MaybePromise<void>
  /**
   * Settles method state created for one credential attempt. Returns `false`
   * only when the attempt still awaits a later response or challenge.
   */
  settle?: ((outcome: Outcome) => MaybePromise<boolean>) | undefined
}

/** Adds request-scoped lifecycle state to internal credential parameters. */
export function attach<parameters extends object>(
  parameters: parameters,
  controller: Controller,
): parameters {
  controllers.set(parameters, controller)
  return parameters
}

/** Reads request-scoped lifecycle state when Fetch owns this credential. */
export function get(parameters: object): Controller | undefined {
  return controllers.get(parameters)
}
