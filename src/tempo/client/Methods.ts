import {
  session as sessionLegacyIntent_,
  sessionManager as sessionLegacy_,
} from '../legacy/client/index.js'
import { session as sessionMethod_ } from '../session/client/Session.js'
import { sessionManager as session_ } from '../session/client/SessionManager.js'
import { charge as charge_ } from './Charge.js'
import { subscription as subscription_ } from './Subscription.js'

const sessionClient = Object.assign(session_, { method: sessionMethod_ })
const sessionLegacyClient = Object.assign(sessionLegacy_, { method: sessionLegacyIntent_ })

/**
 * Creates both Tempo `charge` and `session` client methods from shared parameters.
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
  return [charge_(parameters), sessionClient.method(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & sessionMethod_.Parameters

  /** Creates a Tempo `charge` client method for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates a TIP-1034 client-side streaming session that auto-manages channel open, voucher, top-up, and close flows. */
  export const session = sessionClient
  /** @deprecated Use `tempo.session()` for the TIP-1034 session client. */
  export const sessionLegacy = sessionLegacyClient
  /** Creates a Tempo `subscription` client method for recurring TIP-20 payments. */
  export const subscription = subscription_
}
