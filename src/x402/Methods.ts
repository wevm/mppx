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
  name: Types.paymentMethod,
  intent: Types.exactIntent,
  schema: {
    credential: {
      payload: Types.PaymentPayloadSchema,
    },
    request: z.pipe(
      Types.ExactRequestInputSchema,
      z.transform(({ transfer, ...request }) => ({
        ...request,
        extra: Types.transferToExtra(transfer),
        scheme: Types.schemes[0],
      })),
    ),
  },
})
