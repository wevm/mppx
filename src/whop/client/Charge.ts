import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as Methods from '../Methods.js'

/**
 * Creates a Whop charge method intent for usage on the client.
 *
 * Accepts a `completeCheckout` callback that handles the Whop checkout
 * flow — opening the purchase URL, waiting for the user to pay, and
 * returning the resulting payment ID.
 *
 * @example
 * ```ts
 * import { whop } from 'mppx/client'
 *
 * // Browser: open Whop checkout in a popup
 * const charge = whop.charge({
 *   completeCheckout: async ({ purchaseUrl }) => {
 *     const popup = window.open(purchaseUrl, 'whop-checkout', 'width=500,height=700')
 *     return new Promise((resolve) => {
 *       window.addEventListener('message', (e) => {
 *         if (e.data?.paymentId) resolve(e.data.paymentId)
 *       })
 *     })
 *   },
 * })
 * ```
 *
 * @example
 * ```ts
 * // CLI: open browser and wait for callback
 * const charge = whop.charge({
 *   completeCheckout: async ({ purchaseUrl }) => {
 *     const open = await import('open')
 *     await open.default(purchaseUrl)
 *     // poll your callback server for the payment ID
 *     return await pollForPayment()
 *   },
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const { completeCheckout, externalId } = parameters

  return Method.toClient(Methods.charge, {
    context: z.object({
      /** If the caller already has a payment ID (e.g. returning user), skip checkout. */
      paymentId: z.optional(z.string()),
    }),

    async createCredential({ challenge, context }) {
      // Fast path: caller already completed payment externally
      if (context?.paymentId) {
        return Credential.serialize({
          challenge,
          payload: {
            paymentId: context.paymentId,
            ...(externalId ? { externalId } : {}),
          },
        })
      }

      // Get purchase URL from the challenge's opaque/meta field
      const purchaseUrl = challenge.opaque?.purchase_url
      if (!purchaseUrl) {
        throw new Error(
          'No purchase_url in challenge. The server must include a Whop checkout URL in the challenge meta.',
        )
      }

      const paymentId = await completeCheckout({
        amount: challenge.request.amount as number,
        challengeId: challenge.id,
        currency: challenge.request.currency as string,
        purchaseUrl,
      })

      return Credential.serialize({
        challenge,
        payload: {
          paymentId,
          ...(externalId ? { externalId } : {}),
        },
      })
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /**
     * Callback that completes the Whop checkout flow.
     *
     * Receives the Whop purchase URL and payment details.
     * Must open the checkout (popup, redirect, browser, etc.),
     * wait for the user to complete payment, and return the
     * Whop payment ID.
     *
     * In a browser: open iframe/popup, listen for redirect/postMessage.
     * In a CLI: open default browser, poll a callback endpoint.
     * In an agent: use browser automation or prompt the user.
     */
    completeCheckout: (parameters: CompleteCheckoutParameters) => Promise<string>
    /** Optional client-side external reference ID for the credential payload. */
    externalId?: string | undefined
  }

  type CompleteCheckoutParameters = {
    /** Payment amount in decimal units (e.g., 5.00 for $5). */
    amount: number
    /** The challenge ID, useful for correlating callbacks. */
    challengeId: string
    /** ISO currency code (e.g., "usd"). */
    currency: string
    /** Whop checkout URL. Direct the user here to complete payment. */
    purchaseUrl: string
  }
}
