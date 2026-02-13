import { charge as charge_ } from './Charge.js'

/**
 * Creates a Stripe `charge` client method intent.
 *
 * @example
 * ```ts
 * import { Mpay, stripe } from 'mpay/client'
 *
 * const mpay = Mpay.create({
 *   methods: [
 *     stripe({
 *       createSpt: async (params) => {
 *         const res = await fetch('/api/create-spt', {
 *           method: 'POST',
 *           headers: { 'Content-Type': 'application/json' },
 *           body: JSON.stringify(params),
 *         })
 *         const { spt } = await res.json()
 *         return spt
 *       },
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

  /** Creates a Stripe `charge` client method intent for SPT-based payments. */
  export const charge = charge_
}
