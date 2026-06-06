import { session as sessionLegacy_, settle as settleLegacy_ } from '../legacy/server/index.js'
import {
  charge as sessionCharge_,
  session as session_,
  settle as settle_,
  settleBatch as settleBatch_,
} from '../session/server/Session.js'
import * as Ws_ from '../session/server/Ws.js'
import { charge as charge_ } from './Charge.js'
import { renew as renewSubscription_, subscription as subscription_ } from './Subscription.js'

const sessionServer = Object.assign(session_, {
  charge: sessionCharge_,
  settle: settle_,
  settleBatch: settleBatch_,
})

function createSessionLegacyMethod<
  const parameters extends NonNullable<Parameters<typeof sessionLegacy_>[0]>,
>(parameters?: parameters) {
  return Object.assign(sessionLegacy_(parameters as never), { alias: 'sessionLegacy' as const })
}

const sessionLegacyServer = Object.assign(createSessionLegacyMethod, {
  settle: settleLegacy_,
  Ws: Ws_,
})

function createChargeMethod<const parameters extends tempo.Parameters>(
  parameters: parameters | undefined,
) {
  // `tempo()` accepts the intersection of charge/session parameters, then
  // forwards only the fields each method understands. Keep the generic bridge
  // out of the public control-flow body.
  return tempo.charge(parameters as charge_.Parameters)
}

function createSessionMethod<const parameters extends tempo.Parameters>(
  parameters: parameters | undefined,
) {
  // See `createChargeMethod()`: session receives the same shared parameter bag.
  return sessionServer(parameters as session_.Parameters)
}

/**
 * Creates both Tempo `charge` and `session` methods from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo({ currency: '0x...', recipient: '0x...' })],
 * })
 * ```
 */
export function tempo<const parameters extends tempo.Parameters>(parameters?: parameters) {
  return [createChargeMethod(parameters), createSessionMethod(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & session_.Parameters

  /** Creates a Tempo `charge` method for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates a TIP-1034 Tempo `session` method for session-based TIP-20 token payments. */
  export const session = sessionServer
  /** @deprecated Use `tempo.session()` for the TIP-1034 session server method. */
  export const sessionLegacy = sessionLegacyServer
  /** Creates a Tempo `subscription` method for recurring TIP-20 token payments. */
  export const subscription = subscription_
  /** Renews an overdue Tempo subscription outside of the HTTP request path. */
  export const renewSubscription = renewSubscription_
  /** One-shot settle: reads highest voucher from storage and submits on-chain. */
  export const settle = settle_
  /** Batch-settle precompile-backed session channels. */
  export const settleBatch = settleBatch_
  /** Experimental websocket helpers for Tempo sessions. */
  export const Ws = Ws_
}
