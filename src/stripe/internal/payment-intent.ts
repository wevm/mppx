import type * as Challenge from '../../Challenge.js'
import type * as Credential from '../../Credential.js'
import type { MaybePromise } from '../../internal/types.js'
import type * as Method from '../../Method.js'
import * as z from '../../zod.js'

/** Stripe PaymentIntent options accepted only by server-side method input. */
export const Schema = z.object({
  customer: z.optional(z.string().check(z.minLength(1))),
  hooks: z.optional(
    z.object({
      inputs: z.object({
        tax: z.object({ calculation: z.string().check(z.minLength(1)) }),
      }),
    }),
  ),
  metadata: z.optional(z.record(z.string(), z.string())),
  receipt_email: z.optional(z.string().check(z.minLength(1))),
})

export type Options = z.infer<typeof Schema>

/** Context provided when resolving request-scoped PaymentIntent options. */
export type ResolveOptionsContext = {
  challenge: Challenge.Challenge
  credential: Credential.Credential
  envelope?: Method.VerifiedChallengeEnvelope | undefined
  request: Record<string, unknown>
}

/** Lazily resolves request-scoped PaymentIntent options before the terminal payment operation. */
export type ResolveOptions = (context: ResolveOptionsContext) => MaybePromise<Options | undefined>

export type OptionsInput = Options | ResolveOptions

const ResolveOptionsSchema = z.custom<ResolveOptions>((value) => typeof value === 'function')

/** PaymentIntent options accepted only by server-side method input. */
export const InputSchema = z.union([Schema, ResolveOptionsSchema])

/** Resolves and validates request-scoped PaymentIntent options. */
export async function resolve(
  input: OptionsInput | undefined,
  context: ResolveOptionsContext,
): Promise<Options | undefined> {
  const options = typeof input === 'function' ? await input(context) : input
  return z.optional(Schema).parse(options)
}
