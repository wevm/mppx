import type { CallToolResult, McpError } from '@modelcontextprotocol/sdk/types.js'

import type * as Credential from '../../Credential.js'
import * as core_Mcp from '../../Mcp.js'
import * as Transport from '../../server/Transport.js'

/**
 * MCP SDK tool handler "extra" parameter.
 * Compatible with `@modelcontextprotocol/sdk` RequestHandlerExtra.
 */
export type Extra = {
  _meta?:
    | {
        [core_Mcp.credentialMetaKey]?: Credential.Credential
        [key: string]: unknown
      }
    | undefined
  [key: string]: unknown
}

export type McpSdk = Transport.Transport<Extra, McpError, CallToolResult>

/**
 * MCP SDK transport for server-side payment handling with `@modelcontextprotocol/sdk`.
 *
 * - Reads credentials from `_meta["org.paymentauth/credential"]`
 * - Issues challenges as `McpError` with code `-32042` and challenge in `error.data`
 * - Attaches receipts via `_meta["org.paymentauth/receipt"]` on tool results
 *
 * @example
 * ```ts
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
 * import { Mppx, Transport } from 'mppx/server'
 *
 * const payment = Mppx.create({
 *   method: tempo(),
 *   secretKey: process.env.SECRET_KEY,
 *   transport: Transport.mcpSdk(),
 * })
 *
 * server.registerTool('premium', { description: '...' }, async (extra) => {
 *   const result = await payment.charge({ request: { ... } })(extra)
 *   if (result.status === 402) throw result.challenge
 *   return result.withReceipt({ content: [...] })
 * })
 * ```
 */
export function mcpSdk(): McpSdk {
  let McpErrorClass: typeof McpError | undefined

  return Transport.from<Extra, McpError, CallToolResult>({
    name: 'mcp-sdk',

    captureRequest() {
      return {
        headers: new Headers(),
        method: 'POST',
        url: new URL('mcp://request/sdk'),
      }
    },

    getCredential(extra) {
      const credential = extra._meta?.[core_Mcp.credentialMetaKey]
      if (!credential) return null
      return credential
    },

    async respondChallenge({ challenge, error }) {
      if (!McpErrorClass) {
        try {
          const mod = await import('@modelcontextprotocol/sdk/types.js')
          McpErrorClass = mod.McpError
        } catch (error) {
          const err = new Error(
            'Missing optional dependency "@modelcontextprotocol/sdk". Install it to use mppx MCP SDK transports.',
          )
          ;(err as Error & { cause?: unknown }).cause = error
          throw err
        }
      }
      return new McpErrorClass(core_Mcp.paymentRequiredCode, error?.message ?? 'Payment Required', {
        httpStatus: 402,
        challenges: [challenge],
        ...(error && { problem: error.toProblemDetails(challenge.id) }),
      })
    },

    respondReceipt({ receipt, response, challengeId }) {
      const mcpReceipt: core_Mcp.Receipt = {
        ...receipt,
        challengeId,
      }

      return {
        ...response,
        _meta: {
          ...response._meta,
          [core_Mcp.receiptMetaKey]: mcpReceipt,
        },
      }
    },
  })
}
