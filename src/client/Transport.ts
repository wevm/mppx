import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import * as x402_Header from '../x402/Header.js'
import * as x402_Types from '../x402/Types.js'

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
 * - Extracts x402 exact challenges from `PAYMENT-REQUIRED`
 * - Sends Payment auth credentials via `Authorization`
 * - Sends x402 credentials via `PAYMENT-SIGNATURE`
 */
export function http() {
  return from<RequestInit, Response>({
    name: 'http',

    isPaymentRequired(response) {
      return response.status === 402
    },

    getChallenges(response) {
      return [...paymentAuthChallenges(response), ...x402Challenges(response)]
    },

    getChallenge(response) {
      const challenge = [...paymentAuthChallenges(response), ...x402Challenges(response)][0]
      if (!challenge) throw new Error('No challenge in response.')
      return challenge
    },

    setCredential(request, credential, options) {
      const headers = new Headers(request.headers)
      if (isX402Challenge(options?.challenge)) {
        headers.set(x402_Types.paymentSignatureHeader, credential)
      } else {
        headers.set('Authorization', credential)
      }
      return { ...request, headers }
    },
  })
}

function paymentAuthChallenges(response: Response): Challenge.Challenge[] {
  if (!response.headers.has('WWW-Authenticate')) return []
  return Challenge.fromResponseList(response)
}

function x402Challenges(response: Response): Challenge.Challenge[] {
  const header = response.headers.get(x402_Types.paymentRequiredHeader)
  if (!header) return []
  const paymentRequired = x402_Header.decodePaymentRequired(header)
  return paymentRequired.accepts.map((accepted, index) =>
    Challenge.from({
      id: `x402-${index}`,
      intent: 'exact',
      method: 'x402',
      realm: new URL(paymentRequired.resource.url).host,
      request: {
        ...accepted,
        resource: paymentRequired.resource,
      },
    }),
  )
}

function isX402Challenge(challenge: Challenge.Challenge | undefined): boolean {
  return challenge?.method === 'x402' && challenge.intent === 'exact'
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
