import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import * as Receipt from '../Receipt.js'

/**
 * Server-side transport adapter.
 *
 * Abstracts how challenges are issued and credentials are received
 * across different transport protocols (HTTP, MCP, etc.).
 */
export type Transport<in out input = unknown, in out output = unknown> = {
  /** Transport name for identification. */
  name: string
  /** Extracts credential from the transport input, or null if not present. */
  getCredential: (input: input) => Credential.Credential | null
  /** Creates a transport response for a payment challenge. */
  respondChallenge: (challenge: Challenge.Challenge, input: input) => output
  /** Attaches a receipt to a successful response. */
  respondReceipt: (
    receipt: Receipt.Receipt,
    response: output,
    context: { challengeId: string },
  ) => output
}

/**
 * Creates a custom server-side transport.
 *
 * @example
 * ```ts
 * import { Transport } from 'mpay/server'
 *
 * const custom = Transport.from({
 *   name: 'custom',
 *   getCredential(input) { ... },
 *   respondChallenge(challenge, input) { ... },
 *   respondReceipt(receipt, response, context) { ... },
 * })
 * ```
 */
export function from<const transport extends Transport<any, any>>(
  transport: transport,
): transport {
  return transport
}

/**
 * HTTP transport for server-side payment handling.
 *
 * - Reads credentials from the `Authorization` header
 * - Issues challenges via `WWW-Authenticate` header with 402 status
 * - Attaches receipts via `Payment-Receipt` header
 */
export function http(): Transport<Request, Response> {
  return from({
    name: 'http',

    getCredential(request) {
      const header = request.headers.get('Authorization')
      if (!header) return null
      try {
        return Credential.deserialize(header)
      } catch {
        return null
      }
    },

    respondChallenge(challenge) {
      return new Response(null, {
        status: 402,
        headers: {
          'WWW-Authenticate': Challenge.serialize(challenge),
          'Cache-Control': 'no-store',
        },
      })
    },

    respondReceipt(receipt, response) {
      const headers = new Headers(response.headers)
      headers.set('Payment-Receipt', Receipt.serialize(receipt))
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
  })
}

/**
 * MCP transport for server-side payment handling.
 *
 * - Reads credentials from `_meta["org.paymentauth/credential"]`
 * - Issues challenges via JSON-RPC error with code -32042
 * - Attaches receipts via `_meta["org.paymentauth/receipt"]`
 */
export function mcp(): Transport<Mcp.Request, Mcp.Response> {
  return from({
    name: 'mcp',

    getCredential(request) {
      const meta = request.params?._meta
      const credential = meta?.[Mcp.credentialMetaKey]
      if (!credential) return null
      return credential
    },

    respondChallenge(challenge, request) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: Mcp.paymentRequiredCode,
          message: 'Payment Required',
          data: {
            httpStatus: 402,
            challenges: [challenge],
          },
        },
      }
    },

    respondReceipt(receipt, response, context) {
      if ('error' in response) return response

      const mcpReceipt: Mcp.Receipt = {
        ...receipt,
        challengeId: context.challengeId,
      }

      return {
        ...response,
        result: {
          ...response.result,
          _meta: {
            ...response.result._meta,
            [Mcp.receiptMetaKey]: mcpReceipt,
          },
        },
      }
    },
  })
}
