import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpError } from '@modelcontextprotocol/sdk/types.js'

import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Expires from '../../Expires.js'
import * as AcceptPayment from '../../internal/AcceptPayment.js'
import * as core_Mcp from '../../Mcp.js'
import type * as Method from '../../Method.js'
import type * as z from '../../zod.js'

type AnyClient = Method.Client<any, any>

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
 * import { McpClient, tempo } from 'mppx/mcp-sdk/client'
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
  const methods extends readonly Method.AnyClient[],
>(client: client, config: wrap.Config<methods>): wrap.McpClient<client, methods> {
  const { methods } = config
  const paymentPreferences = AcceptPayment.resolve(methods)

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

        const challenges = getPaymentRequiredChallengesFromResult(result)
        if (challenges)
          return await payAndRetry({
            challenges,
            client,
            context,
            methods,
            params,
            paymentPreferences,
            timeout,
          })

        return {
          ...result,
          receipt: result._meta?.[core_Mcp.receiptMetaKey] as core_Mcp.Receipt | undefined,
        }
      } catch (error) {
        // Check if this is a payment required error
        if (!isPaymentRequiredError(error)) throw error

        const challenges = (error.data as { challenges?: Challenge.Challenge[] })?.challenges
        if (!challenges?.length) throw error

        return await payAndRetry({
          cause: error,
          challenges,
          client,
          context,
          methods,
          params,
          paymentPreferences,
          timeout,
        })
      }
    },
  }
}

/**
 * Alias for `wrap`, named for agent SDK integration guides.
 */
export const withMppClient = wrap

/**
 * Alias for `wrap`, matching common MCP payment wrapper naming.
 */
export const wrapMcpClientWithPayment = wrap

/** Union of all context types from all methods that have context schemas. */
type AnyContextFor<methods extends readonly AnyClient[]> = {
  [key in keyof methods]: methods[key] extends Method.Client<any, infer context>
    ? context extends z.ZodMiniType
      ? z.input<context>
      : undefined
    : undefined
}[number]

export declare namespace wrap {
  type Config<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> = {
    /** Array of methods to use. */
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
    /** Context to pass to the method intent's createCredential. */
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

function getPaymentRequiredChallengesFromResult(
  result: Awaited<ReturnType<Client['callTool']>>,
): Challenge.Challenge[] | null {
  if ((result as { isError?: boolean }).isError !== true) return null

  const structured = (result as { structuredContent?: unknown }).structuredContent
  const structuredChallenges = getPaymentRequiredChallengesFromObject(structured)
  if (structuredChallenges) return structuredChallenges

  const content = (result as { content?: readonly unknown[] }).content
  const first = content?.[0]
  if (
    typeof first !== 'object' ||
    first === null ||
    (first as { type?: unknown }).type !== 'text' ||
    typeof (first as { text?: unknown }).text !== 'string'
  )
    return null

  try {
    return getPaymentRequiredChallengesFromObject(JSON.parse((first as { text: string }).text))
  } catch {
    return null
  }
}

function getPaymentRequiredChallengesFromObject(value: unknown): Challenge.Challenge[] | null {
  if (typeof value !== 'object' || value === null) return null
  if ((value as { httpStatus?: unknown }).httpStatus !== 402) return null
  const challenges = (value as { challenges?: unknown }).challenges
  if (!Array.isArray(challenges) || challenges.length === 0) return null
  return challenges as Challenge.Challenge[]
}

async function payAndRetry<
  const client extends Pick<Client, 'callTool'>,
  const methods extends readonly Method.AnyClient[],
>(parameters: {
  cause?: unknown
  challenges: readonly Challenge.Challenge[]
  client: client
  context: unknown
  methods: methods
  params: Parameters<wrap.McpClient<client, methods>['callTool']>[0]
  paymentPreferences: ReturnType<typeof AcceptPayment.resolve>
  timeout: number | undefined
}): Promise<CallToolResult> {
  const { cause, challenges, client, context, methods, params, paymentPreferences, timeout } =
    parameters

  const selected = AcceptPayment.selectChallenge(challenges, methods, paymentPreferences.entries)
  if (!selected) {
    const available = challenges.map((c) => `${c.method}.${c.intent}`).join(', ')
    const installed = methods.map((m) => `${m.name}.${m.intent}`).join(', ')
    throw new Error(
      `No compatible payment method. Server offers: ${available}. Client has: ${installed}`,
      cause !== undefined ? { cause } : undefined,
    )
  }

  const credential = await createCredential(selected.challenge, {
    context,
    methods,
  })
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

/** @internal */
async function createCredential<methods extends readonly Method.AnyClient[]>(
  challenge: Challenge.Challenge,
  config: {
    context?: unknown
    methods: methods
  },
): Promise<string> {
  const { context, methods } = config

  const mi = methods.find((m) => m.name === challenge.method && m.intent === challenge.intent)
  if (!mi)
    throw new Error(
      `No method found for "${challenge.method}.${challenge.intent}". Available: ${methods.map((m) => `${m.name}.${m.intent}`).join(', ')}`,
    )

  if (challenge.expires) Expires.assert(challenge.expires, challenge.id)

  const parsedContext = mi.context && context !== undefined ? mi.context.parse(context) : undefined
  return mi.createCredential(
    parsedContext !== undefined ? { challenge, context: parsedContext } : ({ challenge } as never),
  )
}
