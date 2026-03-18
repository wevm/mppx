import { charge as charge_ } from './Charge.js'

/**
 * Creates the Radius `charge` client method from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, radius } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [radius({ account })],
 * })
 * ```
 */
export function radius(parameters: radius.Parameters = {}) {
  return [charge_(parameters)] as const
}

export namespace radius {
  export type Parameters = charge_.Parameters

  /** Creates a Radius `charge` client method for one-time ERC-20 token transfers. */
  export const charge = charge_
}
