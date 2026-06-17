import {
  session as sessionLegacyIntent_,
  sessionManager as sessionLegacy_,
} from '../legacy/client/index.js'
import { session as sessionMethod_ } from '../session/client/Session.js'
import { sessionManager as session_ } from '../session/client/SessionManager.js'
import { charge as charge_ } from './Charge.js'
import { subscription as subscription_ } from './Subscription.js'

const sessionClient = Object.assign(sessionMethod_, { manager: session_ })
const sessionLegacyClient = Object.assign(sessionLegacy_, { method: sessionLegacyIntent_ })

/** Creates a TIP-1034 client method, with explicit managed lifecycle helpers attached. */
export { sessionClient as session }

/**
 * Creates the common Tempo `charge` and `session` client methods from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo.common({ account })],
 * })
 * ```
 */
export function tempo(parameters: tempo.Parameters = {}) {
  return [charge_(parameters), sessionClient(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & sessionMethod_.Parameters

  /** Creates a Tempo `charge` client method for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates the common Tempo `charge` and `session` client methods from shared parameters. */
  export const common = tempo
  /** Creates a TIP-1034 client method for Mppx registration. Use `tempo.session.manager()` for direct lifecycle control. */
  export const session = sessionClient
  /** @deprecated Use `tempo.session()` for the TIP-1034 session client method. */
  export const sessionLegacy = sessionLegacyClient
  /** Creates a Tempo `subscription` client method for recurring TIP-20 payments. */
  export const subscription = subscription_
}
