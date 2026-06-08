import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

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

export type McpSdk = Transport.Transport<Extra, CallToolResult, CallToolResult>

/**
 * MCP SDK transport for server-side payment handling with `@modelcontextprotocol/sdk`.
 *
 * - Reads credentials from `_meta["org.paymentauth/credential"]`
 * - Issues challenges as `isError: true` tool results with challenge data
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
 *   if (result.status === 402) return result.challenge
 *   return result.withReceipt({ content: [...] })
 * })
 * ```
 */
export function mcpSdk(): McpSdk {
  return Transport.from<Extra, CallToolResult, CallToolResult>({
    name: 'mcp-sdk',

    captureRequest() {
      return {
        // MCP tool invocations are application content requests even though
        // they do not carry HTTP body headers on the transport boundary.
        hasBody: true,
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

    respondChallenge({ challenge, error }) {
      const paymentRequired = {
        httpStatus: 402,
        challenges: [challenge],
        ...(error && { problem: error.toProblemDetails(challenge.id) }),
      }

      return {
        structuredContent: paymentRequired,
        content: [
          {
            type: 'text',
            text: JSON.stringify(paymentRequired),
          },
        ],
        isError: true,
      }
    },

    respondReceipt({ receipt, response, challengeId }) {
      const mcpReceipt: core_Mcp.Receipt = {
        ...receipt,
        challengeId,
      }

      const normalizedResponse =
        response instanceof globalThis.Response
          ? ({ content: [] } as CallToolResult)
          : (response as CallToolResult)

      return {
        ...normalizedResponse,
        _meta: {
          ...normalizedResponse._meta,
          [core_Mcp.receiptMetaKey]: mcpReceipt,
        },
      }
    },
  })
}
