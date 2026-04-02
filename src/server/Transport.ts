import { Json } from 'ox'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import type { Distribute, UnionToIntersection } from '../internal/types.js'
import * as core_Mcp from '../Mcp.js'
import * as Receipt from '../Receipt.js'
import * as Html from './internal/html/config.js'
import { html } from './internal/html/config.js'
import { serviceWorker } from './internal/html/serviceWorker.gen.js'

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
export function http(): Http {
  return from<Request, Response>({
    name: 'http',

    getCredential(request) {
      const header = request.headers.get('Authorization')
      if (!header) return null
      const payment = Credential.extractPaymentScheme(header)
      if (!payment) return null
      return Credential.deserialize(payment)
    },

    async respondChallenge(options) {
      const { challenge, error, input } = options

      if (options.html && new URL(input.url).searchParams.has(Html.serviceWorkerParam))
        return new Response(serviceWorker, {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-store',
          },
        })

      const headers: Record<string, string> = {
        'WWW-Authenticate': Challenge.serialize(challenge),
        'Cache-Control': 'no-store',
      }

      const body = await (async () => {
        if (options.html && input.headers.get('Accept')?.includes('text/html')) {
          headers['Content-Type'] = 'text/html; charset=utf-8'

          const theme = Html.mergeDefined(
            {
              favicon: undefined as Html.Theme['favicon'],
              fontUrl: undefined as Html.Theme['fontUrl'],
              logo: undefined as Html.Theme['logo'],
              ...Html.defaultTheme,
            },
            (options.html.theme as never) ?? {},
          )
          const text = Html.sanitizeRecord(
            Html.mergeDefined(Html.defaultText, (options.html.text as never) ?? {}),
          )
          const amount = await options.html.formatAmount(challenge.request)

          return html`<!doctype html>
            <html lang="en">
              <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <meta name="robots" content="noindex" />
                <meta name="color-scheme" content="${theme.colorScheme}" />
                <title>${text.title}</title>
                ${Html.favicon(theme, challenge.realm)} ${Html.font(theme)} ${Html.style(theme)}
              </head>
              <body>
                <main>
                  <header class="${Html.classNames.header}">
                    ${Html.logo(theme)}
                    <span>${text.paymentRequired}</span>
                  </header>
                  <section class="${Html.classNames.summary}" aria-label="Payment summary">
                    <h1 class="${Html.classNames.summaryAmount}">${Html.sanitize(amount)}</h1>
                    ${challenge.description
                      ? `<p class="${Html.classNames.summaryDescription}">${Html.sanitize(challenge.description)}</p>`
                      : ''}
                    ${challenge.expires
                      ? `<p class="${Html.classNames.summaryExpires}">${text.expires} <time datetime="${new Date(challenge.expires).toISOString()}">${new Date(challenge.expires).toLocaleString()}</time></p>`
                      : ''}
                  </section>
                  <div id="${Html.rootId}" aria-label="Payment form"></div>
                  <script id="${Html.dataId}" type="application/json">
                    ${Json.stringify({
                      config: options.html.config,
                      challenge,
                      text,
                      theme,
                    } satisfies Html.Data).replace(/</g, '\\u003c')}
                  </script>
                  ${options.html.content}
                </main>
              </body>
            </html> `
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
