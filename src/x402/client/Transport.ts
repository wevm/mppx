import * as Challenge from '../../Challenge.js'
import * as ClientTransport from '../../client/Transport.js'
import * as Header from '../Header.js'
import * as Types from '../Types.js'

/** HTTP transport for x402 v2 header flow. */
export function http() {
  return ClientTransport.from<RequestInit, Response>({
    name: 'x402-http',

    isPaymentRequired(response) {
      return response.status === 402 && response.headers.has(Types.paymentRequiredHeader)
    },

    getChallenges(response) {
      return paymentRequiredToChallenges(Header.decodePaymentRequired(requireHeader(response)))
    },

    getChallenge(response) {
      return paymentRequiredToChallenges(Header.decodePaymentRequired(requireHeader(response)))[0]!
    },

    setCredential(request, credential) {
      const headers = new Headers(request.headers)
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

function paymentRequiredToChallenges(
  paymentRequired: Types.PaymentRequired,
): Challenge.Challenge[] {
  return paymentRequired.accepts.map((accepted, index) =>
    Challenge.from({
      id: `${Types.syntheticChallengeIdPrefix}${index}`,
      intent: Types.exactIntent,
      method: Types.paymentMethod,
      realm: new URL(paymentRequired.resource.url).host,
      request: {
        ...accepted,
        resource: paymentRequired.resource,
      },
    }),
  )
}
