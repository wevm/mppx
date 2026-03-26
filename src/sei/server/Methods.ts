import { charge as charge_ } from './Charge.js'

/**
 * Creates a Sei `charge` method from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, sei } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [sei({ recipient: '0x...' })],
 * })
 * ```
 */
export function sei<const parameters extends sei.Parameters>(parameters?: parameters) {
  return [sei.charge(parameters)] as const
}

export namespace sei {
  export type Parameters = charge_.Parameters

  /** Creates a Sei `charge` method for one-time ERC-20 token transfers. */
  export const charge = charge_
}
