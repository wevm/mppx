import type { NoExtraKeys } from '../../internal/types.js'
import {
  charge as sessionCharge_,
  session as session_,
  settle as settle_,
  settleBatch as settleBatch_,
} from '../session/server/Session.js'
import type { SessionController as SessionController_ } from '../session/server/Sse.js'
import * as Ws_ from '../session/server/Ws.js'
import { charge as charge_ } from './Charge.js'
import type * as Relay_ from './Relay.js'
import { renew as renewSubscription_, subscription as subscription_ } from './Subscription.js'

const sessionServer = Object.assign(session_, {
  charge: sessionCharge_,
  settle: settle_,
  settleBatch: settleBatch_,
})

function createChargeMethod<const parameters extends tempo.Parameters>(
  parameters: parameters | undefined,
) {
  // `tempo()` accepts the intersection of charge/session parameters, then
  // forwards only the fields each method understands. Preserve the inferred
  // parameter type so configured request defaults remain visible to handlers.
  return tempo.charge(parameters as NoExtraKeys<parameters, charge_.Parameters> | undefined)
}

function createSessionMethod<const parameters extends tempo.Parameters>(
  parameters: parameters | undefined,
) {
  // See `createChargeMethod()`: session receives the same shared parameter bag.
  return sessionServer(parameters as NoExtraKeys<parameters, session_.Parameters> | undefined)
}

/**
 * Creates the common Tempo `charge` and `session` methods from shared parameters.
 *
 * `machineTokenEnabled` and `relay` currently apply only to `charge`. The
 * machine-token option is accepted globally so other Tempo methods can adopt
 * it without another provider-level configuration surface.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: tempo({
 *     currency: '0x...',
 *     machineTokenEnabled: true,
 *     recipient: '0x...',
 *   }),
 * })
 * ```
 */
export function tempo<const parameters extends tempo.Parameters>(parameters?: parameters) {
  return [createChargeMethod(parameters), createSessionMethod(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & session_.Parameters
  /** Tempo API relay configuration for server-side charges. */
  export type RelayOptions = charge_.RelayOptions
  /** Stable failure codes returned by Tempo API's MPP relay. */
  export type RelayErrorCode = Relay_.configure.ErrorCode
  /** Safe relay failure details exposed by the Tempo API relay. */
  export type RelayErrorDetails = Relay_.configure.ErrorDetails

  /** Creates a Tempo `charge` method for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates the common Tempo `charge` and `session` methods from shared parameters. */
  export const common = tempo
  /** Creates a TIP-1034 Tempo `session` method for session-based TIP-20 token payments. */
  export const session = sessionServer
  /** Creates a Tempo `subscription` method for recurring TIP-20 token payments. */
  export const subscription = subscription_
  /** Renews an overdue Tempo subscription outside of the HTTP request path. */
  export const renewSubscription = renewSubscription_
  /** One-shot settle: reads highest voucher from storage and submits on-chain. */
  export const settle = settle_
  /** Batch-settle precompile-backed session channels. */
  export const settleBatch = settleBatch_
  /** Types for Tempo session streams. */
  export namespace Sse {
    /** Controller passed to manual-charge SSE generators. */
    export type SessionController = SessionController_
  }
  /** Experimental websocket helpers for Tempo sessions. */
  export const Ws = Ws_
}
