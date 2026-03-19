import { charge as charge_ } from './Charge.js'

/**
 * Creates a Whop `charge` client method.
 *
 * @example
 * ```ts
 * import { Mppx, whop } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     whop({
 *       completeCheckout: async ({ purchaseUrl }) => {
 *         window.open(purchaseUrl)
 *         return await waitForPaymentId()
 *       },
 *     }),
 *   ],
 * })
 * ```
 */
export function whop(parameters: whop.Parameters) {
  return [charge_(parameters)] as const
}

export namespace whop {
  export type Parameters = charge_.Parameters

  /** Creates a Whop `charge` client method for checkout-based payments. */
  export const charge = charge_
}
