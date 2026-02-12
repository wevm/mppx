import { memoryStorage as memoryStorage_ } from '../stream/Storage.js'
import { charge as charge_ } from './Charge.js'
import { session as session_ } from './Session.js'
import { sseTransport as sseTransport_ } from './SseTransport.js'

/**
 * Creates both Tempo `charge` and `session` method intents from shared parameters.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const mpay = Mpay.create({
 *   methods: [tempo({ currency: '0x...', recipient: '0x...' })],
 * })
 * ```
 */
export function tempo<const parameters extends tempo.Parameters>(parameters?: parameters) {
  return [tempo.charge(parameters), tempo.session(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & session_.Parameters

  /** Creates a Tempo `charge` method intent for one-time TIP-20 token transfers. */
  export const charge = charge_
  export const memoryStorage = memoryStorage_
  /** Creates an SSE transport that wires storage into the response pipeline. */
  export const sseTransport = sseTransport_
  /** Creates a Tempo `session` method intent for session-based TIP-20 token payments. */
  export const session = session_
}
