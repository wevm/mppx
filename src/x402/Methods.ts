import * as Method from '../Method.js'
import * as z from '../zod.js'
import * as Types from './Types.js'

/**
 * x402 exact payment method.
 *
 * Public route input accepts typed `transfer` config; the method request output
 * converts it into the x402 wire `extra` object.
 */
export const exact = Method.from({
  name: 'x402',
  intent: 'exact',
  schema: {
    credential: {
      payload: Types.PaymentPayloadSchema,
    },
    request: z.pipe(
      Types.ExactRequestInputSchema,
      z.transform(({ transfer, ...request }) => ({
        ...request,
        extra: Types.transferToExtra(transfer),
        scheme: 'exact' as const,
      })),
    ),
  },
})
