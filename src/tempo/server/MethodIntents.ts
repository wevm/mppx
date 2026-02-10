import { charge as charge_ } from './Charge.js'
import { stream as stream_ } from './Stream.js'

/**
 * Creates both Tempo `charge` and `stream` method intents from shared parameters.
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
export function tempo<const defaults extends tempo.Defaults>(
  parameters: tempo.Parameters<defaults>,
) {
  return [tempo.charge(parameters), tempo.stream(parameters)] as const
}

export namespace tempo {
  export type Defaults = charge_.Defaults & stream_.Defaults

  export type Parameters<defaults extends Defaults = {}> = charge_.Parameters<defaults> &
    stream_.Parameters<defaults>

  /** Creates a Tempo `charge` method intent for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates a Tempo `stream` method intent for streaming TIP-20 token payments. */
  export const stream = stream_
}
