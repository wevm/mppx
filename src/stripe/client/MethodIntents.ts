import { charge as charge_ } from './Charge.js'

/**
 * Creates a Stripe `charge` client method intent.
 *
 * @example
 * ```ts
 * import { Mpay, stripe } from 'mpay/client'
 *
 * const mpay = Mpay.create({
 *   methods: [stripe({ secretKey: 'sk_test_...', paymentMethod: 'pm_card_visa' })],
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
