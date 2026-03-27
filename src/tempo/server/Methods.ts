import { charge as charge_ } from './Charge.js'
import { session as session_, settle as settle_ } from './Session.js'

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
  return [
    tempo.charge(parameters as charge_.Parameters as never),
    tempo.session(parameters as session_.Parameters as never),
  ] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & session_.Parameters

  /** Creates a Tempo `charge` method for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates a Tempo `session` method for session-based TIP-20 token payments. */
  export const session = session_
  /** One-shot settle: reads highest voucher from storage and submits on-chain. */
  export const settle = settle_
}
