import { charge as charge_ } from './Charge.js'
import { stream as stream_ } from './Stream.js'

/**
 * Creates both Tempo `charge` and `stream` client method intents from shared parameters.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/client'
 *
 * const mpay = Mpay.create({
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function tempo(parameters: tempo.Parameters = {}) {
  return [tempo.charge(parameters), tempo.stream(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & stream_.Parameters

  /** Creates a Tempo `charge` client method intent for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates a Tempo `stream` client method intent for streaming TIP-20 token payments. */
  export const stream = stream_
}
