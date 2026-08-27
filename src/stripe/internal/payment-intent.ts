import * as z from '../../zod.js'

/** Stripe PaymentIntent options accepted only by server-side method input. */
export const Schema = z.object({
  metadata: z.record(z.string(), z.string()),
})

export type Options = z.infer<typeof Schema>
