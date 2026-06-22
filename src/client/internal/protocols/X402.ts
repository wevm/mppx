import * as Challenge from '../../../Challenge.js'
import * as x402_Header from '../../../x402/Header.js'
import * as x402_ChallengeBrand from '../../../x402/internal/ChallengeBrand.js'
import * as x402_Types from '../../../x402/Types.js'
import type { Protocol } from './Protocol.js'
import { paymentRequiredStatus, setCredentialHeader } from './Shared.js'

/**
 * x402 — a 402 carrying a `PAYMENT-REQUIRED` header, paid back in `PAYMENT-SIGNATURE`. Synthesized
 * challenges are branded for `evm/client/Charge.ts`, keeping them distinct from native `evm`
 * charges with the same method/intent.
 */
export function x402(): Protocol {
  return {
    getChallenges(response) {
      if (response.status !== paymentRequiredStatus) return []
      const header = response.headers.get(x402_Types.paymentRequiredHeader)
      if (!header) return []
      const paymentRequired = x402_Header.decodePaymentRequired(header)
      if (response.url && paymentRequired.resource.url !== response.url)
        throw new Error('x402 payment-required resource does not match response URL.')
      return paymentRequired.accepts.map((accepted, index) =>
        x402_ChallengeBrand.mark(
          Challenge.from({
            id: `${x402_Types.syntheticChallengeIdPrefix}${index}`,
            intent: x402_Types.exactIntent,
            method: x402_Types.paymentMethod,
            realm: new URL(paymentRequired.resource.url).host,
            request: {
              ...accepted,
              ...(paymentRequired.extensions ? { extensions: paymentRequired.extensions } : {}),
              resource: paymentRequired.resource,
            },
          }),
        ),
      )
    },
    setCredential(request, credential) {
      return setCredentialHeader(request, x402_Types.paymentSignatureHeader, credential)
    },
  }
}
