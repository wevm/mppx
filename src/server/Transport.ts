import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import type { Distribute, UnionToIntersection } from '../internal/types.js'
import * as core_Mcp from '../Mcp.js'
import * as Receipt from '../Receipt.js'
import * as Html from './Html.js'

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
  in receiptResponse = challengeOutput,
  out receiptOutput = receiptResponse,
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
    html?: Html.Options | undefined
    input: input
  }) => challengeOutput | Promise<challengeOutput>
  /** Attaches a receipt to a successful response. */
  respondReceipt: (options: {
    challengeId: string
    receipt: Receipt.Receipt
    response: receiptResponse
  }) => receiptOutput
}
export type AnyTransport = Transport<any, any, any, any>

export type Http = Transport<Request, Response>

export type Mcp = Transport<core_Mcp.JsonRpcRequest, core_Mcp.Response>

export type Sse<stream = any> = Transport<
  Request,
  Response,
  Response | AsyncIterable<string> | ((stream: stream) => AsyncIterable<string>),
  Response
>

/** Extracts the input type from a transport. */
export type InputOf<transport extends AnyTransport = AnyTransport> =
  transport extends Transport<infer input, any, any> ? input : never

/** Extracts the challenge output type from a transport. */
export type ChallengeOutputOf<transport extends AnyTransport = AnyTransport> =
  transport extends Transport<any, infer challengeOutput, any> ? challengeOutput : never

/** Extracts the receipt output type from a transport. */
export type ReceiptResponseOf<transport extends AnyTransport = AnyTransport> =
  transport extends Transport<any, any, infer response, any> ? response : never

/** Extracts the resolved receipt type (return type of respondReceipt). */
export type ReceiptOutputOf<transport extends AnyTransport = AnyTransport> =
  transport extends Transport<any, any, any, infer output> ? output : never

/**
 * The `withReceipt` overload set for a given transport.
 *
 * Produces one overload per union member of `ReceiptOutputOf<transport>`,
 * so TypeScript can contextually type generator function parameters.
 */
export type WithReceipt<transport extends AnyTransport = Http> = WithReceiptOverloads<transport>

/**
 * Creates a custom server-side transport.
 *
 * @example
 * ```ts
 * import { Transport } from 'mppx/server'
 *
 * const custom = Transport.from({
 *   name: 'custom',
 *   getCredential(input) { ... },
 *   respondChallenge({ challenge, input }) { ... },
 *   respondReceipt({ receipt, response, challengeId }) { ... },
 * })
 * ```
 */
export function from<
  input = unknown,
  challengeOutput = unknown,
  receiptOutput = challengeOutput,
  receiptResolved = receiptOutput,
>(
  transport: Transport<input, challengeOutput, receiptOutput, receiptResolved>,
): Transport<input, challengeOutput, receiptOutput, receiptResolved> {
  return transport
}

/**
 * HTTP transport for server-side payment handling.
 *
 * - Reads credentials from the `Authorization` header
 * - Issues challenges via `WWW-Authenticate` header with 402 status
 * - Attaches receipts via `Payment-Receipt` header
 */
export function http(options?: http.Options): Http {
  const renderHtml = (() => {
    if (options?.html === false) return
    if (!options?.html || options.html === true) return Html.render
    return options.html
  })()

  return from<Request, Response>({
    name: 'http',

    getCredential(request) {
      const header = request.headers.get('Authorization')
      if (!header) return null
      const payment = Credential.extractPaymentScheme(header)
      if (!payment) return null
      return Credential.deserialize(payment)
    },

    respondChallenge({ challenge, error, html, input }) {
      const headers: Record<string, string> = {
        'WWW-Authenticate': Challenge.serialize(challenge),
        'Cache-Control': 'no-store',
      }

      const body = (() => {
        if (renderHtml && html?.content && input.headers.get('Accept')?.includes('text/html')) {
          headers['Content-Type'] = 'text/html; charset=utf-8'
          return renderHtml({
            challenge,
            content: html.content,
            config: html?.config,
            theme: html?.theme,
            text: html?.text,
          })
        }
        if (error) {
          headers['Content-Type'] = 'application/problem+json'
          return JSON.stringify(error.toProblemDetails(challenge.id))
        }
        return null
      })()

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

export declare namespace http {
  type Options = {
    /**
     * Serve an HTML payment page to browsers (requests with `Accept: text/html`).
     *
     * - `true` — use the built-in payment page
     * - `(props) => string` — custom HTML renderer
     */
    html?: boolean | ((props: Html.Props) => string) | undefined
  }
}

/** @internal */
function mcpErrorCode(error?: Errors.PaymentError): number {
  if (!error) return core_Mcp.paymentRequiredCode
  if (error instanceof Errors.MalformedCredentialError) return -32602
  if (error instanceof Errors.PaymentRequiredError) return core_Mcp.paymentRequiredCode
  return core_Mcp.paymentVerificationFailedCode
}

/** @internal Distributes over the receipt response union to create overloads. */
type WithReceiptOverloads<transport extends AnyTransport = Http> = {
  // biome-ignore lint/style/useShorthandFunctionType: _
  (): ReceiptOutputOf<transport>
} & UnionToIntersection<Distribute<ReceiptResponseOf<transport>, ReceiptOutputOf<transport>>>
