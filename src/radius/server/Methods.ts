import { charge as charge_ } from './Charge.js'

/**
 * Creates the Radius `charge` method from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, radius } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [radius({ currency: '0x...', recipient: '0x...' })],
 * })
 * ```
 */
export function radius<const parameters extends radius.Parameters>(parameters?: parameters) {
  return [radius.charge(parameters)] as const
}

export namespace radius {
  export type Parameters = charge_.Parameters

  /** Creates a Radius `charge` method for one-time ERC-20 token transfers. */
  export const charge = charge_
}
