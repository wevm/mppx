import { charge as charge_ } from './Charge.js'

/**
 * Creates a Stripe `charge` method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { Mpay, stripe } from 'mpay/server'
 *
 * const mpay = Mpay.create({
 *   methods: [stripe({ secretKey: 'sk_...' })],
 * })
 * ```
 */
export function stripe<const parameters extends stripe.Parameters>(parameters: parameters) {
  return [stripe.charge(parameters)] as const
}

export namespace stripe {
  export type Parameters = charge_.Parameters

  /** Creates a Stripe `charge` method intent for SPT-based payments. */
  export const charge = charge_
}
