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
      requires: ['recipient', 'expires'],
    },
  },
})

/**
 * Tempo authorize intent for payment authorization with spending limits.
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-authorize-00.md
 */
export const authorize = MethodIntent.fromIntent(Intent.authorize, {
  method: 'tempo',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({ hash: z.hash(), type: z.literal('hash') }),
        z.object({ signature: z.signature(), type: z.literal('keyAuthorization') }),
        z.object({ signature: z.signature(), type: z.literal('transaction') }),
      ]),
    },
    request: {
      methodDetails: z.object({
        chainId: z.optional(z.number()),
        feePayer: z.optional(z.boolean()),
        memo: z.optional(z.hash()),
        validFrom: z.optional(z.datetime()),
      }),
    },
  },
})

/**
 * Tempo subscription intent for recurring payment authorization.
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-subscription-00.md
 */
export const subscription = MethodIntent.fromIntent(Intent.subscription, {
  method: 'tempo',
  schema: {
    credential: {
      payload: z.object({ signature: z.signature(), type: z.literal('keyAuthorization') }),
    },
    request: {
      methodDetails: z.object({
        chainId: z.optional(z.number()),
        memo: z.optional(z.hash()),
        validFrom: z.optional(z.datetime()),
      }),
    },
  },
})
