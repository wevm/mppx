import type { Account, Address } from 'viem'
import { parseUnits } from 'viem'

import * as Method from '../Method.js'
import * as z from '../zod.js'
import type { SubscriptionPeriodUnit } from './subscription/Types.js'

export const chargeModes = ['push', 'pull'] as const
export type ChargeMode = (typeof chargeModes)[number]

const split = z.object({
  amount: z.amount(),
  memo: z.optional(z.hash()),
  recipient: z.pipe(
    z.string(),
    z.transform((v) => v as Address),
  ),
})

const uint64Max = (1n << 64n) - 1n
const secondsPerDay = 86_400n
const secondsPerWeek = 604_800n

const normalizedAddress = z.pipe(
  z.address(),
  z.transform((value) => value.toLowerCase() as Address),
)

const subscriptionAccessKey = z.object({
  accessKeyAddress: normalizedAddress,
  keyType: z.enum(['p256', 'secp256k1', 'webAuthn']),
})

const subscriptionMethodDetails = z.object({
  accessKey: z.optional(subscriptionAccessKey),
  chainId: z.optional(z.number()),
})

const subscriptionExpires = z
  .pipe(
    z.datetime(),
    z.transform((value) => new Date(value)),
  )
  .check(
    z.refine(
      (value) => value.getTime() % 1_000 === 0,
      'subscriptionExpires must be representable as whole seconds',
    ),
  )

const subscriptionPeriodUnits = ['day', 'week'] as const satisfies readonly SubscriptionPeriodUnit[]
const subscriptionPeriodUnit = z.enum(subscriptionPeriodUnits)

const uint64String = z.string().check(
  z.regex(/^[1-9]\d*$/, 'Invalid periodCount'),
  z.refine((value) => {
    try {
      return BigInt(value) <= uint64Max
    } catch {
      return false
    }
  }, 'periodCount exceeds uint64'),
)

function positiveParsedAmount(message: string) {
  return z.refine((value) => {
    const { amount, decimals } = value as { amount: string; decimals: number }
    return parseUnits(amount, decimals) > 0n
  }, message)
}

function subscriptionPeriodFitsUint64(value: unknown) {
  const { periodCount, periodUnit } = value as {
    periodCount: string
    periodUnit: SubscriptionPeriodUnit
  }
  try {
    const unitSeconds = periodUnit === 'day' ? secondsPerDay : secondsPerWeek
    return BigInt(periodCount) * unitSeconds <= uint64Max
  } catch {
    return false
  }
}

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
        z.object({ signature: z.signature(), type: z.literal('proof') }),
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
          supportedModes: z.optional(z.array(z.enum(chargeModes)).check(z.minLength(1))),
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
      z.transform(
        ({ amount, chainId, decimals, feePayer, memo, splits, supportedModes, ...rest }) => ({
          ...rest,
          amount: parseUnits(amount, decimals).toString(),
          ...(chainId !== undefined ||
          feePayer !== undefined ||
          memo !== undefined ||
          splits !== undefined ||
          supportedModes !== undefined
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
                  ...(supportedModes !== undefined && { supportedModes }),
                },
              }
            : {}),
        }),
      ),
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
      z
        .object({
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
        })
        .check(
          z.refine(
            ({ amount, decimals }) => parseUnits(amount, decimals) > 0n,
            'Session amount must be greater than 0',
          ),
        ),
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

/**
 * Tempo subscription intent for recurring TIP-20 token transfers.
 *
 * Uses a signed key authorization that delegates one transfer per billing period.
 */
export const subscription = Method.from({
  name: 'tempo',
  intent: 'subscription',
  schema: {
    credential: {
      payload: z.object({
        signature: z.signature(),
        type: z.literal('keyAuthorization'),
      }),
    },
    request: z.pipe(
      z
        .object({
          amount: z.amount(),
          accessKey: z.optional(subscriptionAccessKey),
          chainId: z.optional(z.number()),
          currency: normalizedAddress,
          decimals: z.number(),
          description: z.optional(z.string()),
          externalId: z.optional(z.string()),
          methodDetails: z.optional(subscriptionMethodDetails),
          periodCount: uint64String,
          periodUnit: subscriptionPeriodUnit,
          recipient: normalizedAddress,
          subscriptionExpires,
        })
        .check(
          positiveParsedAmount('Subscription amount must be greater than 0'),
          z.refine(subscriptionPeriodFitsUint64, 'Subscription period exceeds uint64'),
        ),
      z.transform(
        ({ accessKey, amount, chainId, decimals, methodDetails, subscriptionExpires, ...rest }) => {
          // Accept top-level convenience input, but serialize Tempo-specific fields under methodDetails.
          const nextMethodDetails: {
            accessKey?: z.infer<typeof subscriptionAccessKey> | undefined
            chainId?: number | undefined
          } = {
            ...methodDetails,
            ...(accessKey !== undefined && { accessKey }),
            ...(chainId !== undefined && { chainId }),
          }

          return {
            ...rest,
            amount: parseUnits(amount, decimals).toString(),
            subscriptionExpires: subscriptionExpires.toISOString(),
            ...(Object.keys(nextMethodDetails).length > 0
              ? {
                  methodDetails: nextMethodDetails,
                }
              : {}),
          }
        },
      ),
    ),
  },
})
