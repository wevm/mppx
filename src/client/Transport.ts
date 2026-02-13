import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'

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
  /** Extracts the challenge from a payment-required response. */
  getChallenge: (response: response) => Challenge.Challenge
  /** Attaches a credential to a request. */
  setCredential: (request: request, credential: string) => request
}
export type AnyTransport = Transport<any, any>

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
 * - Extracts challenges from `WWW-Authenticate` header
 * - Sends credentials via `Authorization` header
 */
export function http() {
  return from<RequestInit, Response>({
    name: 'http',

    isPaymentRequired(response) {
      return response.status === 402
    },

    getChallenge(response) {
      return Challenge.fromResponse(response)
    },

    setCredential(request, credential) {
      const headers = new Headers(request.headers)
      headers.set('Authorization', credential)
      return { ...request, headers }
    },
  })
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
