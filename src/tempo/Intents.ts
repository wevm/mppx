import * as Intent from '../Intent.js'
import * as MethodIntent from '../MethodIntent.js'
import * as z from '../zod.js'

/**
 * Tempo charge intent for one-time TIP-20 token transfers.
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-charge-00.md
 */
export const charge = MethodIntent.fromIntent(Intent.charge, {
  method: 'tempo',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({ hash: z.hash(), type: z.literal('hash') }),
        z.object({ signature: z.signature(), type: z.literal('transaction') }),
      ]),
    },
    request: {
      methodDetails: z.object({
        chainId: z.optional(z.number()),
        feePayer: z.optional(z.boolean()),
        memo: z.optional(z.hash()),
      }),
      requires: ['recipient'],
    },
  },
})
