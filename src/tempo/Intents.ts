import type { Account } from 'viem'
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
        feePayer: z.optional(
          z.pipe(
            z.union([z.boolean(), z.custom<Account>()]),
            z.transform((v): boolean => (typeof v === 'object' ? true : v)),
          ),
        ),
        memo: z.optional(z.hash()),
      }),
      requires: ['decimals', 'recipient'],
    },
  },
})

/**
 * Tempo stream intent for pay-as-you-go streaming payments.
 *
 * Uses cumulative vouchers over a payment channel. Credential payloads
 * are a discriminated union on `action`: open, topUp, voucher, close.
 */
export const stream = MethodIntent.fromIntent(Intent.stream, {
  method: 'tempo',
  schema: {
    credential: {
      payload: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('open'),
          type: z.union([z.literal('hash'), z.literal('transaction')]),
          channelId: z.hash(),
          hash: z.optional(z.hash()),
          signature: z.optional(z.signature()),
          authorizedSigner: z.optional(z.string()),
          cumulativeAmount: z.amount(),
          voucherSignature: z.signature(),
        }),
        z.object({
          action: z.literal('topUp'),
          channelId: z.hash(),
          topUpTxHash: z.hash(),
          cumulativeAmount: z.amount(),
          voucherSignature: z.signature(),
        }),
        z.object({
          action: z.literal('voucher'),
          channelId: z.hash(),
          cumulativeAmount: z.amount(),
          signature: z.signature(),
        }),
        z.object({
          action: z.literal('close'),
          channelId: z.hash(),
          cumulativeAmount: z.amount(),
          voucherSignature: z.signature(),
        }),
      ]),
    },
    request: {
      methodDetails: z.object({
        escrowContract: z.string(),
        channelId: z.optional(z.hash()),
        minVoucherDelta: z.optional(z.amount()),
        chainId: z.optional(z.number()),
      }),
      requires: ['recipient'],
    },
  },
})
