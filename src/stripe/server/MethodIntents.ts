import { charge as charge_ } from './Charge.js'

/**
 * Creates Stripe method intents from shared parameters.
 *
 * @example
 * ```ts
 * import { Mpay } from 'mpay/server'
 * import { stripe } from 'mpay/stripe/server'
 *
 * const mpay = Mpay.create({
 *   methods: [stripe({ apiKey: 'sk_live_...' })],
 * })
 * ```
 */
export function stripe<const parameters extends stripe.Parameters>(parameters: parameters) {
  return [charge_(parameters)] as const
}

export namespace stripe {
  export type Parameters = charge_.Parameters

  /** Creates a Stripe `charge` method intent for SPT-based payments. */
  export const charge = charge_
}
