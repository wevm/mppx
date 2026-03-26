import { charge as charge_ } from './Charge.js'

/**
 * Creates a Sei `charge` client method from shared parameters.
 *
 * @example
 * ```ts
 * import { Mppx, sei } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [sei({ account })],
 * })
 * ```
 */
export function sei(parameters: sei.Parameters = {}) {
  return [charge_(parameters)] as const
}

export namespace sei {
  export type Parameters = charge_.Parameters

  /** Creates a Sei `charge` client method for one-time ERC-20 token transfers. */
  export const charge = charge_
}
