import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as ServerTransport from '../../server/Transport.js'
import * as Header from '../Header.js'
import * as Types from '../Types.js'

/** HTTP transport for x402 v2 header flow. */
export function http() {
  return ServerTransport.from<Request, Response>({
    name: 'x402-http',

    captureRequest(request) {
      return {
        hasBody: request.body !== null,
        headers: new Headers(request.headers),
        method: request.method,
        url: ServerTransport.safeUrl(request.url),
      }
    },

    getCredential(request) {
      const header = request.headers.get(Types.paymentSignatureHeader)
      if (!header) return null
      const paymentPayload = Header.decodePaymentSignature(header)

      return Credential.from({
        challenge: Challenge.from({
          id: 'x402-pending',
          intent: Types.exactIntent,
          method: Types.paymentMethod,
          realm: 'x402',
          request: paymentPayload.accepted,
        }),
        payload: paymentPayload,
      })
    },

    bindCredential({ challenge, credential }) {
      return Credential.from({
        challenge,
        payload: credential.payload,
      })
    },

    respondChallenge({ challenge, error, input }) {
      const request = challenge.request as Types.ExactRequest
      const resource = request.resource ?? {
        url: input.url,
      }
      const paymentRequired: Types.PaymentRequired = {
        accepts: [Types.toPaymentRequirements(request)],
        error: error?.message ?? `${Types.paymentSignatureHeader} header is required`,
        resource,
        x402Version: 2,
      }

      return new Response('{}', {
        status: error?.status ?? 402,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
          [Types.paymentRequiredHeader]: Header.encodePaymentRequired(paymentRequired),
        },
      })
    },

    respondReceipt({ credential, receipt, response }) {
      const paymentPayload = Types.PaymentPayloadSchema.parse(credential.payload)
      const headers = new Headers(response.headers)
      headers.set(
        Types.paymentResponseHeader,
        Header.encodePaymentResponse({
          network: paymentPayload.accepted.network,
          payer: payerOf(paymentPayload.payload),
          success: true,
          transaction: receipt.reference,
        }),
      )
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      })
    },
  })
}

function payerOf(payload: Types.ExactPayload): string | undefined {
  if ('authorization' in payload) return payload.authorization.from
  return payload.permit2Authorization.from
}
