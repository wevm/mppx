import type { Account, Address } from 'viem'
import { parseUnits } from 'viem'

import * as Method from '../Method.js'
import * as z from '../zod.js'

const split = z.object({
  amount: z.amount(),
  memo: z.optional(z.hash()),
  recipient: z.pipe(
    z.string(),
    z.transform((v) => v as Address),
  ),
})

/**
 * Tempo charge intent for one-time TIP-20 token transfers.
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-charge-00.md
 */
export const charge = Method.from({
  name: 'tempo',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({ hash: z.hash(), type: z.literal('hash') }),
        z.object({ signature: z.signature(), type: z.literal('transaction') }),
      ]),
    },
    request: z.pipe(
      z
        .object({
          amount: z.amount(),
          chainId: z.optional(z.number()),
          currency: z.string(),
          decimals: z.number(),
          description: z.optional(z.string()),
          externalId: z.optional(z.string()),
          feePayer: z.optional(
            z.pipe(
              z.union([z.boolean(), z.custom<Account>()]),
              z.transform((v): boolean => (typeof v === 'object' ? true : v)),
            ),
          ),
          memo: z.optional(z.hash()),
          recipient: z.optional(z.string()),
          splits: z.optional(z.array(split).check(z.minLength(1), z.maxLength(10))),
        })
        .check(
          z.refine(({ amount, decimals, splits }) => {
            if (!splits) return true

            const totalAmount = parseUnits(amount, decimals)
            const splitTotal = splits.reduce(
              (sum, split) => sum + parseUnits(split.amount, decimals),
              0n,
            )

            return (
              splits.every((split) => parseUnits(split.amount, decimals) > 0n) &&
              splitTotal < totalAmount
            )
          }, 'Invalid splits'),
        ),
      z.transform(({ amount, chainId, decimals, feePayer, memo, splits, ...rest }) => ({
        ...rest,
        amount: parseUnits(amount, decimals).toString(),
        ...(chainId !== undefined ||
        feePayer !== undefined ||
        memo !== undefined ||
        splits !== undefined
          ? {
              methodDetails: {
                ...(chainId !== undefined && { chainId }),
                ...(feePayer !== undefined && { feePayer }),
                ...(memo !== undefined && { memo }),
                ...(splits !== undefined && {
                  splits: splits.map((split) => ({
                    ...split,
                    amount: parseUnits(split.amount, decimals).toString(),
                  })),
                }),
              },
            }
          : {}),
      })),
    ),
  },
})

/**
 * Tempo session intent for pay-as-you-go streaming payments.
 *
 * Uses cumulative vouchers over a payment channel. Credential payloads
 * are a discriminated union on `action`: open, topUp, voucher, close.
 */
export const session = Method.from({
  name: 'tempo',
  intent: 'session',
  schema: {
    credential: {
      payload: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('open'),
          authorizedSigner: z.optional(z.string()),
          channelId: z.hash(),
          cumulativeAmount: z.amount(),
          signature: z.signature(),
          transaction: z.signature(),
          type: z.literal('transaction'),
        }),
        z.object({
          action: z.literal('topUp'),
          additionalDeposit: z.amount(),
          channelId: z.hash(),
          transaction: z.signature(),
          type: z.literal('transaction'),
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
          signature: z.signature(),
        }),
      ]),
    },
    request: z.pipe(
      z.object({
        amount: z.amount(),
        chainId: z.optional(z.number()),
        channelId: z.optional(z.hash()),
        currency: z.string(),
        decimals: z.number(),
        escrowContract: z.optional(z.string()),
        feePayer: z.optional(
          z.pipe(
            z.union([z.boolean(), z.custom<Account>()]),
            z.transform((v): boolean => (typeof v === 'object' ? true : v)),
          ),
        ),
        minVoucherDelta: z.optional(z.amount()),
        recipient: z.optional(z.string()),
        suggestedDeposit: z.optional(z.amount()),
        unitType: z.string(),
      }),
      z.transform(
        ({
          amount,
          chainId,
          channelId,
          decimals,
          escrowContract,
          feePayer,
          minVoucherDelta,
          suggestedDeposit,
          ...rest
        }) => ({
          ...rest,
          amount: parseUnits(amount, decimals).toString(),
          ...(suggestedDeposit
            ? {
                suggestedDeposit: parseUnits(suggestedDeposit, decimals).toString(),
              }
            : {}),
          methodDetails: {
            escrowContract,
            ...(channelId !== undefined && { channelId }),
            ...(minVoucherDelta !== undefined && {
              minVoucherDelta: parseUnits(minVoucherDelta, decimals).toString(),
            }),
            ...(chainId !== undefined && { chainId }),
            ...(feePayer !== undefined && { feePayer }),
          },
        }),
      ),
    ),
  },
})
