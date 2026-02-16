import { charge as charge_ } from './Charge.js'

/**
 * Creates a Stripe `charge` client method.
 *
 * @example
 * ```ts
 * import { Mppx, stripe } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     stripe({
 *       createToken: async (params) => {
 *         const res = await fetch('/api/create-spt', {
 *           method: 'POST',
 *           headers: { 'Content-Type': 'application/json' },
 *           body: JSON.stringify(params),
 *         })
 *         const { spt } = await res.json()
 *         return spt
 *       },
 *       paymentMethod: 'pm_card_visa',
 *     }),
 *   ],
 * })
 * ```
 */
export function stripe(parameters: stripe.Parameters) {
  return [charge_(parameters)] as const
}

export namespace stripe {
  export type Parameters = charge_.Parameters

  /** Creates a Stripe `charge` client method for SPT-based payments. */
  export const charge = charge_
}
