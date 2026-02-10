import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import * as core_Mcp from '../Mcp.js'
import * as Receipt from '../Receipt.js'

export { type McpSdk, mcpSdk } from '../mcp-sdk/server/Transport.js'

/**
 * Server-side transport adapter.
 *
 * Abstracts how challenges are issued and credentials are received
 * across different transport protocols (HTTP, MCP, etc.).
 */
export type Transport<
  in out input = unknown,
  in out challengeOutput = unknown,
  in out receiptOutput = challengeOutput,
> = {
  /** Transport name for identification. */
  name: string
  /**
   * Extracts credential from the transport input.
   * Returns `null` if no credential was provided, or throws if malformed.
   */
  getCredential: (input: input) => Credential.Credential | null
  /** Creates a transport response for a payment challenge. */
  respondChallenge: (options: {
    challenge: Challenge.Challenge
    error?: Errors.PaymentError | undefined
    input: input
  }) => challengeOutput | Promise<challengeOutput>
  /** Attaches a receipt to a successful response. */
  respondReceipt: (options: {
    challengeId: string
    receipt: Receipt.Receipt
    response: receiptOutput
  }) => receiptOutput
}
export type AnyTransport = Transport<any, any, any>

export type Http = Transport<Request, Response>

export type Mcp = Transport<core_Mcp.JsonRpcRequest, core_Mcp.Response>

/** Extracts the input type from a transport. */
export type InputOf<transport extends Transport = Transport> =
  transport extends Transport<infer input, any, any> ? input : never

/** Extracts the challenge output type from a transport. */
export type ChallengeOutputOf<transport extends Transport = Transport> =
  transport extends Transport<any, infer challengeOutput, any> ? challengeOutput : never

/** Extracts the receipt output type from a transport. */
export type ReceiptOutputOf<transport extends Transport = Transport> =
  transport extends Transport<any, any, infer receiptOutput> ? receiptOutput : never

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
 *   respondChallenge({ challenge, input }) { ... },
 *   respondReceipt({ receipt, response, challengeId }) { ... },
 * })
 * ```
 */
export function from<input = unknown, challengeOutput = unknown, receiptOutput = challengeOutput>(
  transport: Transport<input, challengeOutput, receiptOutput>,
): Transport<input, challengeOutput, receiptOutput> {
  return transport
}

/**
 * HTTP transport for server-side payment handling.
 *
 * - Reads credentials from the `Authorization` header
 * - Issues challenges via `WWW-Authenticate` header with 402 status
 * - Attaches receipts via `Payment-Receipt` header
 */
export function http() {
  return from<Request, Response>({
    name: 'http',

    getCredential(request) {
      const header = request.headers.get('Authorization')
      if (!header) return null
      const payment = Credential.extractPaymentScheme(header)
      if (!payment) return null
      return Credential.deserialize(payment)
    },

    respondChallenge({ challenge, error }) {
      const headers: Record<string, string> = {
        'WWW-Authenticate': Challenge.serialize(challenge),
        'Cache-Control': 'no-store',
      }

      let body: string | null = null
      if (error) {
        headers['Content-Type'] = 'application/problem+json'
        body = JSON.stringify(error.toProblemDetails(challenge.id))
      }

      return new Response(body, { status: error?.status ?? 402, headers })
    },

    respondReceipt({ receipt, response }) {
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
 * MCP transport for server-side payment handling with raw JSON-RPC.
 *
 * - Reads credentials from `_meta["org.paymentauth/credential"]`
 * - Issues challenges via JSON-RPC error with code -32042/-32043
 * - Attaches receipts via `_meta["org.paymentauth/receipt"]`
 *
 * Use this transport when handling raw JSON-RPC messages directly.
 * For use with `@modelcontextprotocol/sdk`, use `mcpSdk()` instead.
 */
export function mcp() {
  return from<core_Mcp.JsonRpcRequest, core_Mcp.Response>({
    name: 'mcp',

    getCredential(request) {
      const meta = request.params?._meta
      const credential = meta?.[core_Mcp.credentialMetaKey]
      if (!credential) return null
      return credential
    },

    respondChallenge({ challenge, input, error }) {
      return {
        jsonrpc: '2.0',
        id: input.id,
        error: {
          code: mcpErrorCode(error),
          message: error?.message ?? 'Payment Required',
          data: {
            httpStatus: error?.status ?? 402,
            challenges: [challenge],
            ...(error && { problem: error.toProblemDetails(challenge.id) }),
          },
        },
      }
    },

    respondReceipt({ receipt, response, challengeId }) {
      if ('error' in response) return response

      const mcpReceipt: core_Mcp.Receipt = {
        ...receipt,
        challengeId,
      }

      return {
        ...response,
        result: {
          ...response.result,
          _meta: {
            ...response.result._meta,
            [core_Mcp.receiptMetaKey]: mcpReceipt,
          },
        },
      }
    },
  })
}

function mcpErrorCode(error?: Errors.PaymentError): number {
  if (!error) return core_Mcp.paymentRequiredCode
  if (error instanceof Errors.MalformedCredentialError) return -32602
  if (error instanceof Errors.PaymentRequiredError) return core_Mcp.paymentRequiredCode
  return core_Mcp.paymentVerificationFailedCode
}
