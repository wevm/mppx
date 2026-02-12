import * as Intent from '../Intent.js'
import * as MethodIntent from '../MethodIntent.js'
import * as z from '../zod.js'

/**
 * Stripe charge intent for one-time payments via Shared Payment Tokens (SPTs).
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/stripe/draft-stripe-charge-00.md
 */
export const charge = MethodIntent.fromIntent(Intent.charge, {
  method: 'stripe',
  schema: {
    credential: {
      payload: z.object({ spt: z.string() }),
    },
    request: {
      methodDetails: z.object({
        networkId: z.string(),
      }),
    },
  },
})
