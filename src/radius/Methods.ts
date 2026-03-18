import { parseUnits } from 'viem'
import * as Method from '../Method.js'
import * as z from '../zod.js'

/**
 * Radius charge intent for one-time ERC-20 token transfers.
 *
 * Supports two credential types:
 * - `hash`:   Client broadcasts a standard ERC-20 `transfer()` and sends the tx hash.
 * - `permit`: Client signs an EIP-2612 permit; the server executes `permit()` + `transferFrom()`.
 */
export const charge = Method.from({
  name: 'radius',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({ hash: z.hash(), type: z.literal('hash') }),
        z.object({
          type: z.literal('permit'),
          owner: z.string(),
          deadline: z.string(),
          signature: z.signature(),
        }),
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
