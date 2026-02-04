import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpError } from '@modelcontextprotocol/sdk/types.js'
import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as core_Mcp from '../../Mcp.js'
import type * as Method from '../../Method.js'
import type * as z from '../../zod.js'

type AnyClient = Method.Client<any, any, any>

/**
 * Result of a tool call with payment handling.
 * Extends the SDK's callTool return type with an optional payment receipt.
 */
export type CallToolResult = Awaited<ReturnType<Client['callTool']>> & {
  /** Payment receipt if payment was made. */
  receipt: core_Mcp.Receipt | undefined
}

/**
 * Creates a payment-aware wrapper around an MCP SDK client.
 *
 * Similar to `Fetch.from()` for HTTP, this wraps an MCP client's `callTool`
 * method to automatically handle payment challenges.
 *
 * @example
 * ```ts
 * import { Client } from '@modelcontextprotocol/sdk/client'
 * import { McpClient, tempo } from 'mpay/mcp-sdk/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const client = new Client({ name: 'my-client', version: '1.0.0' })
 * await client.connect(transport)
 *
 * const mcp = McpClient.wrap(client, {
 *   methods: [
 *     tempo({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 *
 * // Automatically handles payment challenges
 * const result = await mcp.callTool({ name: 'premium_tool', arguments: {} })
 * console.log(result.content, result.receipt)
 * ```
 */
export function wrap<
  const client extends Pick<Client, 'callTool'>,
  const methods extends readonly AnyClient[],
>(client: client, config: wrap.Config<methods>): wrap.McpClient<client, methods> {
  const { methods } = config

  return {
    ...client,
    async callTool(params, options) {
      const context = options?.context
      const timeout = options?.timeout

      try {
        const result = await client.callTool(
          params,
          undefined,
          timeout !== undefined ? { timeout } : undefined,
        )

        return {
          ...result,
          receipt: result._meta?.[core_Mcp.receiptMetaKey] as core_Mcp.Receipt | undefined,
        }
      } catch (error) {
        // Check if this is a payment required error
        if (!isPaymentRequiredError(error)) throw error

        const challenges = (error.data as { challenges?: Challenge.Challenge[] })?.challenges
        if (!challenges?.length) throw error

        // Select first challenge that matches an installed method
        const challenge = challenges.find((c) => methods.some((m) => m.name === c.method))
        if (!challenge) {
          const available = challenges.map((c) => c.method).join(', ')
          const installed = methods.map((m) => m.name).join(', ')
          throw new Error(
            `No compatible payment method. Server offers: ${available}. Client has: ${installed}`,
          )
        }

        const credential = await createCredential(challenge, { context, methods })
        const parsed = Credential.deserialize(credential)

        const retryResult = await client.callTool(
          {
            ...params,
            _meta: {
              ...params._meta,
              [core_Mcp.credentialMetaKey]: parsed,
            },
          },
          undefined,
          timeout !== undefined ? { timeout } : undefined,
        )

        return {
          ...retryResult,
          receipt: retryResult._meta?.[core_Mcp.receiptMetaKey] as core_Mcp.Receipt | undefined,
        }
      }
    },
  }
}

/** Union of all context types from all methods that have context schemas. */
type AnyContextFor<methods extends readonly AnyClient[]> = {
  [key in keyof methods]: methods[key] extends Method.Client<any, any, infer context>
    ? context extends z.ZodMiniType
      ? z.input<context>
      : undefined
    : undefined
}[number]

export declare namespace wrap {
  type Config<methods extends readonly AnyClient[] = readonly AnyClient[]> = {
    /** Array of payment methods to use. */
    methods: methods
  }

  type McpClient<
    client extends Pick<Client, 'callTool'> = Pick<Client, 'callTool'>,
    methods extends readonly AnyClient[] = readonly AnyClient[],
  > = Omit<client, 'callTool'> & {
    /** Call a tool with automatic payment handling. */
    callTool: (
      params: {
        name: string
        arguments?: Record<string, unknown>
        _meta?: Record<string, unknown>
      },
      options?: CallToolOptions<methods>,
    ) => Promise<CallToolResult>
  }

  type CallToolOptions<methods extends readonly AnyClient[] = readonly AnyClient[]> = {
    /** Context to pass to the payment method's createCredential. */
    context?: AnyContextFor<methods>
    /** Request timeout in milliseconds. */
    timeout?: number
  }
}

/**
 * Checks if an error is a payment required error.
 */
export function isPaymentRequiredError(
  error: unknown,
): error is McpError & { data: { challenges: Challenge.Challenge[] } } {
  if (typeof error !== 'object' || error === null) return false
  if (!('code' in error) || !('message' in error)) return false
  if ((error as { code: unknown }).code !== core_Mcp.paymentRequiredCode) return false
  const data = (error as { data?: { challenges?: unknown } }).data
  return Array.isArray(data?.challenges) && data.challenges.length > 0
}

/** @internal */
async function createCredential<methods extends readonly AnyClient[]>(
  challenge: Challenge.Challenge,
  config: {
    context?: unknown
    methods: methods
  },
): Promise<string> {
  const { context, methods } = config

  const method = methods.find((m) => m.name === challenge.method)
  if (!method)
    throw new Error(
      `No method found for "${challenge.method}". Available: ${methods.map((m) => m.name).join(', ')}`,
    )

  const parsedContext =
    method.context && context !== undefined ? method.context.parse(context) : undefined
  return method.createCredential(
    parsedContext !== undefined ? { challenge, context: parsedContext } : ({ challenge } as never),
  )
}
