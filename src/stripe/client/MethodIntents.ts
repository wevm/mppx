import { charge as charge_ } from './Charge.js'

/**
 * Creates Stripe client method intents from shared parameters.
 *
 * @example
 * ```ts
 * import { Mpay } from 'mpay/client'
 * import { stripe } from 'mpay/stripe/client'
 *
 * const mpay = Mpay.create({
 *   methods: [stripe({ apiKey: 'sk_test_...', paymentMethod: 'pm_card_visa' })],
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
