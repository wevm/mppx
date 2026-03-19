import { charge as charge_ } from './Charge.js'

/**
 * Creates a Whop `charge` method for usage on the server.
 *
 * @example
 * ```ts
 * import { Mppx, whop } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     whop({
 *       apiKey: process.env.WHOP_API_KEY!,
 *       companyId: 'biz_xxx',
 *       currency: 'usd',
 *     }),
 *   ],
 * })
 * ```
 */
export function whop<const parameters extends whop.Parameters>(parameters: parameters) {
  return [whop.charge(parameters)] as const
}

export namespace whop {
  export type Parameters = charge_.Parameters

  /** Creates a Whop `charge` method for checkout-based payments. */
  export const charge = charge_
}
