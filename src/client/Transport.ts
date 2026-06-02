import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import * as x402_Header from '../x402/Header.js'
import * as x402_ChallengeBrand from '../x402/internal/ChallengeBrand.js'
import * as x402_Types from '../x402/Types.js'

const paymentRequiredStatus = 402
const paymentAuthChallengeHeader = 'WWW-Authenticate'
const paymentAuthCredentialHeader = 'Authorization'
const credentialHeaders = [
  paymentAuthCredentialHeader,
  x402_Types.paymentRequiredHeader,
  x402_Types.paymentResponseHeader,
  x402_Types.paymentSignatureHeader,
]

/**
 * Client-side transport adapter.
 *
 * Abstracts how challenges are received and credentials are sent
 * across different transport protocols (HTTP, MCP, etc.).
 */
export type Transport<in out request = unknown, in out response = unknown> = {
  /** Transport name for identification. */
  name: string
  /** Checks if a response indicates payment is required. */
  isPaymentRequired: (response: response) => boolean
  /** Extracts all challenges from a payment-required response, when the transport supports multiple offers. */
  getChallenges?: (response: response) => Challenge.Challenge[]
  /** Extracts the challenge from a payment-required response. */
  getChallenge: (response: response) => Challenge.Challenge
  /** Attaches a credential to a request. */
  setCredential: (
    request: request,
    credential: string,
    options?: setCredential.Options | undefined,
  ) => request
}
export type AnyTransport = Transport<any, any>

export declare namespace setCredential {
  type Options = {
    /** Challenge selected for credential creation. */
    challenge?: Challenge.Challenge | undefined
  }
}

/** Extracts the response type from a transport. */
export type ResponseOf<transport extends Transport> =
  transport extends Transport<any, infer response> ? response : never

/** Extracts the request type from a transport. */
export type RequestOf<transport extends Transport> =
  transport extends Transport<infer request, any> ? request : never

/**
 * Creates a custom client-side transport.
 *
 * @example
 * ```ts
 * import { Transport } from 'mppx/client'
 *
 * const custom = Transport.from({
 *   name: 'custom',
 *   isPaymentRequired(response) { ... },
 *   getChallenge(response) { ... },
 *   setCredential(request, credential) { ... },
 * })
 * ```
 */
export function from<request, response>(
  transport: Transport<request, response>,
): Transport<request, response> {
  return transport
}

/**
 * HTTP transport for client-side payment handling.
 *
 * - Detects payment required via 402 status
 * - Extracts Payment auth challenges from `WWW-Authenticate`
 * - Falls back to x402 exact challenges from `PAYMENT-REQUIRED`
 * - Sends credentials via `Authorization` or `PAYMENT-SIGNATURE`
 */
export function http() {
  return from<RequestInit, Response>({
    name: 'http',

    isPaymentRequired(response) {
      return response.status === paymentRequiredStatus
    },

    getChallenges(response) {
      return paymentRequiredChallenges(response)
    },

    getChallenge(response) {
      const challenge = paymentRequiredChallenges(response)[0]
      if (!challenge) throw new Error('No challenge in response.')
      return challenge
    },

    setCredential(request, credential, options) {
      const headers = new Headers(request.headers)
      for (const header of credentialHeaders) headers.delete(header)
      if (isX402Challenge(options?.challenge)) {
        headers.set(x402_Types.paymentSignatureHeader, credential)
      } else {
        headers.set(paymentAuthCredentialHeader, credential)
      }
      return { ...request, headers }
    },
  })
}

function paymentRequiredChallenges(response: Response): Challenge.Challenge[] {
  return [
    ...(response.headers.has(paymentAuthChallengeHeader)
      ? Challenge.fromResponseList(response)
      : []),
    ...x402Challenges(response),
  ]
}

function x402Challenges(response: Response): Challenge.Challenge[] {
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
}

function isX402Challenge(challenge: Challenge.Challenge | undefined): boolean {
  return x402_ChallengeBrand.is(challenge)
}

/**
 * MCP transport for client-side payment handling.
 *
 * - Detects payment required via error code -32042
 * - Extracts challenges from `error.data.challenges[0]`
 * - Sends credentials via `_meta["org.paymentauth/credential"]`
 */
export function mcp() {
  return from<Mcp.Request, Mcp.Response>({
    name: 'mcp',

    isPaymentRequired(response) {
      return 'error' in response && response.error?.code === Mcp.paymentRequiredCode
    },

    getChallenges(response) {
      if (!('error' in response) || !response.error) throw new Error('Response is not an error.')
      const challenges = response.error.data?.challenges
      if (!challenges?.length) throw new Error('No challenge in error response.')
      return challenges
    },

    getChallenge(response) {
      if (!('error' in response) || !response.error) throw new Error('Response is not an error.')
      const challenge = response.error.data?.challenges[0]
      if (!challenge) throw new Error('No challenge in error response.')
      return challenge
    },

    setCredential(request, credential) {
      const parsed = Credential.deserialize(credential)
      return {
        ...request,
        params: {
          ...request.params,
          _meta: {
            ...request.params?._meta,
            [Mcp.credentialMetaKey]: parsed,
          },
        },
      }
    },
  })
}
