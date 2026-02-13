import { parseUnits } from 'viem'
import * as Expires from './Expires.js'
import * as z from './zod.js'

/**
 * A payment intent.
 */
export type Intent = {
  name: string
  schema: {
    request: z.z.ZodMiniObject | z.z.ZodMiniPipe<z.z.ZodMiniObject>
  }
}

/**
 * Creates an intent.
 *
 * @example
 * ```ts
 * import { z } from 'mppx'
 *
 * const charge = Intent.from({
 *   name: 'charge',
 *   schema: {
 *     request: z.object({
 *       amount: z.string(),
 *       currency: z.string(),
 *       recipient: z.optional(z.string()),
 *     }),
 *   },
 * })
 * ```
 */
export function from<const intent extends Intent>(intent: intent): intent {
  return intent
}

/**
 * Charge intent for one-time immediate payments.
 *
 * @see https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-charge-00.md
 */
export const charge = from({
  name: 'charge',
  schema: {
    request: z.pipe(
      z.object({
        amount: z.amount(),
        currency: z.string(),
        decimals: z.number(),
        description: z.optional(z.string()),
        expires: z._default(z.datetime(), () => Expires.minutes(5)),
        externalId: z.optional(z.string()),
        recipient: z.optional(z.string()),
      }),
      // Note: Since the spec states we must have `amount` as a base unit, we
      // will transform the amount to decimal units based on `decimals`.
      z.transform(({ amount, decimals, ...rest }) => ({
        ...rest,
        amount: parseUnits(amount, decimals).toString(),
      })),
    ),
  },
})

/**
 * Session intent for pay-as-you-go streaming payments.
 *
 * Uses cumulative vouchers over a payment channel for
 * incremental micropayments without per-request transactions.
 */
export const session = from({
  name: 'session',
  schema: {
    request: z.pipe(
      z.object({
        amount: z.amount(),
        unitType: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.optional(z.string()),
        suggestedDeposit: z.optional(z.amount()),
      }),
      z.transform(({ amount, decimals, suggestedDeposit, ...rest }) => ({
        ...rest,
        amount: parseUnits(amount, decimals).toString(),
        ...(suggestedDeposit
          ? { suggestedDeposit: parseUnits(suggestedDeposit, decimals).toString() }
          : {}),
      })),
    ),
  },
})

/** @internal Extracts shape from an intent's request schema, supporting both object and pipe. */
export type ShapeOf<intent extends Intent> = intent['schema']['request'] extends z.z.ZodMiniObject
  ? intent['schema']['request']['shape']
  : intent['schema']['request'] extends z.z.ZodMiniPipe<infer A>
    ? A extends z.z.ZodMiniObject
      ? A['shape']
      : never
    : never

/** @internal Extracts the inner object from a pipe or returns the schema directly. */
export function shapeOf(intent: Intent): Record<string, z.z.ZodMiniType> {
  const { request } = intent.schema
  if ('shape' in request) return request.shape as Record<string, z.z.ZodMiniType>
  return (request as any)._zod.def.in.shape
}
