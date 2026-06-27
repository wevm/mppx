import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import { mcp as mcpProtocol, paymentRequiredData } from './internal/protocols/Mcp.js'
import { mpp as mppProtocol } from './internal/protocols/Mpp.js'
import type { Protocol } from './internal/protocols/Protocol.js'
import { paymentRequiredStatus } from './internal/protocols/Shared.js'
import { x402 as x402Protocol } from './internal/protocols/X402.js'

/**
 * Client-side transport adapter.
 *
 * Abstracts how challenges are received and credentials are sent
 * across different transport protocols (HTTP, MCP, etc.).
 */
export type Transport<in out request = unknown, in out response = unknown> = {
  /** Transport name for identification. */
  name: string
  /**
   * Checks if a response indicates payment is required. May inspect the request (to gate
   * body reads) and be async (to read a response body).
   */
  isPaymentRequired: (response: response, request?: request) => boolean | Promise<boolean>
  /** Extracts all challenges from a payment-required response, when the transport supports multiple offers. */
  getChallenges?: (
    response: response,
    request?: request,
  ) => Challenge.Challenge[] | Promise<Challenge.Challenge[]>
  /** Extracts the challenge from a payment-required response. */
  getChallenge: (
    response: response,
    request?: request,
  ) => Challenge.Challenge | Promise<Challenge.Challenge>
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

/** HTTP transport that composes payment protocols while keeping `fetch` as the single boundary. */
export function http(): Transport<RequestInit, Response> {
  const protocols: readonly Protocol[] = [mppProtocol(), x402Protocol(), mcpProtocol()]
  const protocolForChallenge = new WeakMap<Challenge.Challenge, Protocol>()

  const remember = (protocol: Protocol, challenges: Challenge.Challenge[]) => {
    for (const challenge of challenges) protocolForChallenge.set(challenge, protocol)
    return challenges
  }

  // Collect every protocol offer. Header-only 402 paths stay synchronous; MCP returns a promise
  // only when it has to inspect a JSON-RPC/SSE body.
  const collect = (
    response: Response,
    request?: RequestInit,
  ): Challenge.Challenge[] | Promise<Challenge.Challenge[]> => {
    const collectFrom = (
      index: number,
      collected: Challenge.Challenge[],
    ): Challenge.Challenge[] | Promise<Challenge.Challenge[]> => {
      for (let i = index; i < protocols.length; i++) {
        const protocol = protocols[i]!
        const challenges = protocol.getChallenges(response, request)
        if (challenges instanceof Promise)
          return challenges.then((list) =>
            collectFrom(i + 1, [...collected, ...remember(protocol, list)]),
          )
        collected.push(...remember(protocol, challenges))
      }
      return collected
    }
    return collectFrom(0, [])
  }

  return from<RequestInit, Response>({
    name: 'http',

    isPaymentRequired(response, request) {
      if (response.status === paymentRequiredStatus) return true // HTTP 402 — sync fast path
      const challenges = collect(response, request)
      return challenges instanceof Promise
        ? challenges.then((list) => list.length > 0)
        : challenges.length > 0
    },

    getChallenges(response, request) {
      return collect(response, request)
    },

    getChallenge(response, request) {
      const pick = (challenges: Challenge.Challenge[]): Challenge.Challenge => {
        const challenge = challenges[0]
        if (!challenge) throw new Error('No challenge in response.')
        return challenge
      }
      const challenges = collect(response, request)
      return challenges instanceof Promise ? challenges.then(pick) : pick(challenges)
    },

    setCredential(request, credential, options) {
      const protocol = options?.challenge ? protocolForChallenge.get(options.challenge) : undefined
      const fallback = protocols[0]
      if (!protocol && !fallback) throw new Error('No protocol to attach the credential.')
      return (protocol ?? fallback)!.setCredential(request, credential)
    },
  })
}

function mcpPaymentRequiredChallenges(response: Mcp.Response) {
  const data = paymentRequiredData(response)
  if (!data) throw new Error('No challenge in response.')
  return data.challenges
}

/**
 * MCP protocol transport for direct JSON-RPC objects.
 *
 * Prefer {@link http} for MCP-over-HTTP fetches; this remains for callers that already operate on
 * parsed MCP request/response objects.
 */
export function mcp() {
  return from<Mcp.Request, Mcp.Response>({
    name: 'mcp',

    isPaymentRequired(response) {
      return !!paymentRequiredData(response)
    },

    getChallenges(response) {
      return mcpPaymentRequiredChallenges(response)
    },

    getChallenge(response) {
      const challenge = mcpPaymentRequiredChallenges(response)[0]
      if (!challenge) throw new Error('No challenge in response.')
      return challenge
    },

    setCredential(request, credential) {
      const parsed = Credential.deserialize(credential)
      return {
        ...request,
        params: {
          ...request.params,
          ['_meta']: {
            ...request.params?.['_meta'],
            [Mcp.credentialMetaKey]: parsed,
          },
        },
      }
    },
  })
}
