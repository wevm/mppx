import { parseUnits } from 'viem'

import * as Method from '../Method.js'
import * as z from '../zod.js'

/**
 * Sei charge intent for one-time ERC-20 token transfers.
 */
export const charge = Method.from({
  name: 'sei',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({ hash: z.hash(), type: z.literal('hash') }),
        z.object({ signature: z.signature(), type: z.literal('transaction') }),
      ]),
    },
    request: z.pipe(
      z.object({
        amount: z.amount(),
        chainId: z.optional(z.number()),
        currency: z.string(),
        decimals: z.number(),
        description: z.optional(z.string()),
        externalId: z.optional(z.string()),
        recipient: z.optional(z.string()),
      }),
      z.transform(({ amount, chainId, decimals, ...rest }) => ({
        ...rest,
        amount: parseUnits(amount, decimals).toString(),
        ...(chainId !== undefined
          ? { methodDetails: { chainId } }
          : {}),
      })),
    ),
  },
})
