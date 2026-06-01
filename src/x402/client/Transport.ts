import * as Challenge from '../../Challenge.js'
import * as ClientTransport from '../../client/Transport.js'
import * as Header from '../Header.js'
import * as ChallengeBrand from '../internal/ChallengeBrand.js'
import * as Types from '../Types.js'

/** HTTP transport for x402 v2 header flow. */
export function http() {
  return ClientTransport.from<RequestInit, Response>({
    name: 'x402-http',

    isPaymentRequired(response) {
      return response.status === 402 && response.headers.has(Types.paymentRequiredHeader)
    },

    getChallenges(response) {
      return responseToChallenges(response)
    },

    getChallenge(response) {
      return responseToChallenges(response)[0]!
    },

    setCredential(request, credential) {
      const headers = new Headers(request.headers)
      headers.delete('Authorization')
      headers.delete(Types.paymentRequiredHeader)
      headers.delete(Types.paymentResponseHeader)
      headers.delete(Types.paymentSignatureHeader)
      headers.set(Types.paymentSignatureHeader, credential)
      return { ...request, headers }
    },
  })
}

function requireHeader(response: Response): string {
  const header = response.headers.get(Types.paymentRequiredHeader)
  if (!header) throw new Error(`Missing ${Types.paymentRequiredHeader} header.`)
  return header
}

function responseToChallenges(response: Response): Challenge.Challenge[] {
  const paymentRequired = Header.decodePaymentRequired(requireHeader(response))
  if (response.url && paymentRequired.resource.url !== response.url)
    throw new Error('x402 payment-required resource does not match response URL.')
  return paymentRequiredToChallenges(paymentRequired)
}

function paymentRequiredToChallenges(
  paymentRequired: Types.PaymentRequired,
): Challenge.Challenge[] {
  return paymentRequired.accepts.map((accepted, index) =>
    ChallengeBrand.mark(
      Challenge.from({
        id: `${Types.syntheticChallengeIdPrefix}${index}`,
        intent: Types.exactIntent,
        method: Types.paymentMethod,
        realm: new URL(paymentRequired.resource.url).host,
        request: {
          ...accepted,
          ...(paymentRequired.extensions ? { extensions: paymentRequired.extensions } : {}),
          resource: paymentRequired.resource,
        },
      }),
    ),
  )
}
