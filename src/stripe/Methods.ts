import { parseUnits } from 'viem'
import * as Expires from '../Expires.js'
import * as Method from '../Method.js'
import * as z from '../zod.js'

/**
 * Stripe charge intent for one-time payments via Shared Payment Tokens (SPTs).
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/stripe/draft-stripe-charge-00.md
 */
export const charge = Method.from({
  method: 'stripe',
  name: 'charge',
  schema: {
    credential: {
      payload: z.object({
        externalId: z.optional(z.string()),
        spt: z.string(),
      }),
    },
    request: z.pipe(
      z.object({
        amount: z.amount(),
        currency: z.string(),
        decimals: z.number(),
        description: z.optional(z.string()),
        expires: z._default(z.datetime(), () => Expires.minutes(5)),
        externalId: z.optional(z.string()),
        metadata: z.optional(z.record(z.string(), z.string())),
        networkId: z.string(),
        paymentMethodTypes: z.array(z.string()).check(z.minLength(1)),
        recipient: z.optional(z.string()),
      }),
      z.transform(({ amount, decimals, metadata, networkId, paymentMethodTypes, ...rest }) => ({
        ...rest,
        amount: parseUnits(amount, decimals).toString(),
        methodDetails: {
          networkId,
          paymentMethodTypes,
          ...(metadata !== undefined && { metadata }),
        },
      })),
    ),
  },
})
