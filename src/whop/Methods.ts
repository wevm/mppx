import * as Method from '../Method.js'
import * as z from '../zod.js'

/**
 * Whop charge intent for one-time payments via Whop Checkout.
 *
 * The payer completes a Whop-hosted checkout (card, Apple Pay, etc.)
 * and the server verifies the payment via the Whop API.
 *
 * No Whop backend changes required — uses the existing public API:
 * - `checkoutConfigurations.create()` to generate a purchase URL
 * - `payments.retrieve()` to verify payment after completion
 */
export const charge = Method.from({
  name: 'whop',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({
        /** Whop payment ID returned after checkout completion. */
        paymentId: z.string(),
        /** Optional client-side external reference ID. */
        externalId: z.optional(z.string()),
      }),
    },
    request: z.object({
      /** Payment amount in decimal units (e.g., 5.00 for $5). */
      amount: z.number(),
      /** ISO currency code (e.g., "usd"). */
      currency: z.string(),
      /** Merchant's Whop company ID (biz_xxx). */
      companyId: z.string(),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
    }),
  },
})
