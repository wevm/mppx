import { getAddress, parseUnits } from 'viem'

import * as Method from '../Method.js'
import * as z from '../zod.js'
import * as Types from './Types.js'

/** Native Payment-auth EVM charge method. */
export const charge = Method.from({
  name: Types.paymentMethod,
  intent: Types.chargeIntent,
  schema: {
    credential: {
      payload: Types.ChargePayloadSchema,
    },
    request: z.pipe(
      Types.ChargeRequestInputSchema,
      z.transform(
        ({
          amount,
          chainId,
          credentialTypes = ['authorization'],
          currency,
          decimals,
          permit2Address,
          recipient,
          splits,
          ...request
        }) => ({
          ...request,
          amount: parseUnits(amount, decimals).toString(),
          currency: getAddress(currency),
          methodDetails: {
            chainId,
            credentialTypes,
            decimals,
            ...(permit2Address ? { permit2Address: getAddress(permit2Address) } : {}),
            ...(splits ? { splits } : {}),
          },
          recipient: getAddress(recipient),
        }),
      ),
    ),
  },
})
