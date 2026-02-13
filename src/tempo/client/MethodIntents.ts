import { charge as charge_ } from './Charge.js'
import { session as sessionIntent_ } from './Session.js'
import { sessionManager as session_ } from './SessionManager.js'

/**
 * Creates both Tempo `charge` and `session` client method intents from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function tempo(parameters: tempo.Parameters = {}) {
  return [charge_(parameters), sessionIntent_(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & sessionIntent_.Parameters

  /** Creates a Tempo `charge` client method intent for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates a client-side streaming session for managing payment channels. */
  export const session = session_
}
