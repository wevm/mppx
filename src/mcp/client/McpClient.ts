import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpError } from '@modelcontextprotocol/sdk/types.js'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Expires from '../../Expires.js'
import * as AcceptPayment from '../../internal/AcceptPayment.js'
import * as core_Mcp from '../../Mcp.js'
import type * as Method from '../../Method.js'
import * as z from '../../zod.js'

type AnyClient = Method.Client<any, any>
type Methods = readonly (Method.AnyClient | readonly Method.AnyClient[])[]
type DefaultMethods = readonly [Method.AnyClient | readonly Method.AnyClient[]]
type CallToolParams = Parameters<Client['callTool']>[0]
type CallToolResultSchema = Parameters<Client['callTool']>[1]
type CallToolRequestOptions = Parameters<Client['callTool']>[2]
type PaymentRequiredData = NonNullable<core_Mcp.ErrorObject['data']>

const MPPX_MCP_CLIENT_WRAPPER = Symbol.for('mppx.mcp.client.wrapper')

export type OnPaymentRequired = (challenge: Challenge.Challenge) => boolean | Promise<boolean>

/**
 * Result of a tool call with payment handling.
 * Extends the SDK's callTool return type with an optional payment receipt.
 */
export type CallToolResult = Awaited<ReturnType<Client['callTool']>> & {
  /** Payment receipt if payment was made. */
  receipt: core_Mcp.Receipt | undefined
}

/**
 * Adds automatic payment handling to an MCP SDK client.
 *
 * The client's `callTool` method is replaced in place and the same reference
 * is returned, so surfaces that keep using the original client become
 * payment-aware — including when another SDK owns the client reference (e.g.
 * Cloudflare Agents). The MCP SDK `callTool(params, resultSchema?, options?)`
 * signature is preserved; pass a method's `context` or a per-call
 * `onPaymentRequired` approval hook via the options argument, where they are
 * stripped before the remaining request options are forwarded to the SDK.
 * Payment challenges are handled whether they arrive as payment-required
 * errors or as tool results carrying payment-required metadata. Calling
 * `wrap()` again replaces the payment configuration.
 *
 * @example
 * ```ts
 * import { Client } from '@modelcontextprotocol/sdk/client'
 * import { tempo } from 'mppx/client'
 * import { McpClient } from 'mppx/mcp/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const client = new Client({ name: 'my-client', version: '1.0.0' })
 * await client.connect(transport)
 *
 * McpClient.wrap(client, {
 *   methods: [
 *     tempo({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 *
 * // Automatically handles payment challenges
 * const result = await client.callTool({ name: 'premium_tool', arguments: {} })
 * console.log(result.content, result.receipt)
 * ```
 */
export function wrap<const client extends Pick<Client, 'callTool'>, const methods extends Methods>(
  client: client,
  config: wrap.Config<methods>,
): wrap.McpClient<client, methods> {
  const target = client as client & { [MPPX_MCP_CLIENT_WRAPPER]?: Client['callTool'] }
  const originalCallTool = target[MPPX_MCP_CLIENT_WRAPPER] ?? target.callTool
  const callTool = createPaymentAwareCallTool(originalCallTool.bind(client), config)

  Object.defineProperty(target, MPPX_MCP_CLIENT_WRAPPER, {
    configurable: true,
    value: originalCallTool,
  })

  Object.defineProperty(target, 'callTool', {
    configurable: true,
    enumerable: false,
    value: (
      params: CallToolParams,
      resultSchema?: CallToolResultSchema,
      options?: wrap.CallToolOptions<methods>,
    ) => {
      const { context, onPaymentRequired, ...requestOptions } =
        options ?? ({} as wrap.CallToolOptions<methods>)
      return callTool(params, {
        context,
        onPaymentRequired:
          onPaymentRequired === null ? undefined : (onPaymentRequired ?? config.onPaymentRequired),
        requestOptions: Object.keys(requestOptions).length
          ? (requestOptions as CallToolRequestOptions)
          : undefined,
        resultSchema,
      })
    },
    writable: true,
  })

  return target as unknown as wrap.McpClient<client, methods>
}

export declare namespace wrap {
  type Config<methods extends Methods = Methods> = {
    /** Optional approval hook called before creating a payment credential. */
    onPaymentRequired?: OnPaymentRequired
    /** Filters and sorts supported Challenges before Credential creation. */
    orderChallenges?: AcceptPayment.OrderChallenges<FlattenMethods<methods>> | undefined
    /** Client-declared supported payment methods, keyed by typed `method/intent` strings. */
    paymentPreferences?: AcceptPayment.Config<FlattenMethods<methods>> | undefined
    /** Array of methods to use. Accepts individual clients or tuples (e.g. from `tempo()`). */
    methods: methods
  }

  type McpClient<
    client extends Pick<Client, 'callTool'> = Pick<Client, 'callTool'>,
    methods extends Methods = DefaultMethods,
  > = Omit<client, 'callTool'> & {
    /** Call a tool with automatic payment handling. Preserves the MCP SDK signature. */
    callTool: (
      params: CallToolParams,
      resultSchema?: CallToolResultSchema,
      options?: CallToolOptions<methods>,
    ) => Promise<CallToolResult>
  }

  type CallToolOptions<methods extends Methods = DefaultMethods> = CallToolRequestOptions & {
    /** Context to pass to the method intent's createCredential. */
    context?: AnyContextForMethods<methods>
    /** Per-call approval hook; overrides the configured hook. Pass `null` to bypass it. */
    onPaymentRequired?: OnPaymentRequired | null
  }
}

/** Minimal wire shape of payment-required data; challenges are validated, extra fields pass through. */
const PaymentRequiredSchema = z.object({
  challenges: z.array(Challenge.Schema).check(z.minLength(1)),
})

/**
 * Checks if an error is a payment required error.
 */
export function isPaymentRequiredError(
  error: unknown,
): error is McpError & { data: PaymentRequiredData } {
  if (typeof error !== 'object' || error === null) return false
  if (!('code' in error) || !('message' in error)) return false
  if ((error as { code: unknown }).code !== core_Mcp.paymentRequiredCode) return false
  return isPaymentRequiredData((error as { data?: unknown }).data)
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

/** Normalized per-call inputs for the payment-aware adapter. @internal */
type CallToolCall = {
  context?: unknown
  onPaymentRequired?: OnPaymentRequired | undefined
  requestOptions?: CallToolRequestOptions | undefined
  resultSchema?: CallToolResultSchema | undefined
}

function createPaymentAwareCallTool<methods extends Methods>(
  callTool: Client['callTool'],
  config: wrap.Config<methods>,
): (params: CallToolParams, call: CallToolCall) => Promise<CallToolResult> {
  const methods = config.methods.flat() as unknown as FlattenMethods<methods>
  const paymentPreferences = AcceptPayment.resolve(methods, config.paymentPreferences)

  const retryWithPayment = async (
    params: CallToolParams,
    call: CallToolCall,
    paymentRequired: PaymentRequiredData,
    cause: unknown,
  ) => {
    const challenges = paymentRequired.challenges
    const candidates = AcceptPayment.selectChallengeCandidates(
      challenges,
      methods,
      paymentPreferences.entries,
    )
    const orderedCandidates = config.orderChallenges
      ? await config.orderChallenges(candidates)
      : candidates
    const selected = orderedCandidates[0]

    if (!selected) {
      const available = challenges.map((challenge) => `${challenge.method}.${challenge.intent}`)
      const installed = methods.map((method) => `${method.name}.${method.intent}`)
      throw new Error(
        `No compatible payment method. Server offers: ${available.join(', ')}. Client has: ${installed.join(', ')}`,
        { cause },
      )
    }

    if (selected.challenge.expires)
      Expires.assert(selected.challenge.expires, selected.challenge.id)

    if (call.onPaymentRequired) {
      const approved = await call.onPaymentRequired(selected.challenge)
      if (!approved) throw new Error('Payment declined.', { cause })
    }

    const credential = await createCredential(selected.challenge, {
      context: call.context,
      methods,
    })
    const parsed = Credential.deserialize(credential)

    const retryResult = await callTool(
      {
        ...params,
        _meta: {
          ...params._meta,
          [core_Mcp.credentialMetaKey]: parsed,
        },
      },
      call.resultSchema,
      call.requestOptions,
    )

    return withReceipt(retryResult)
  }

  return async (params, call) => {
    try {
      const result = await callTool(params, call.resultSchema, call.requestOptions)
      const paymentRequired = getPaymentRequiredMeta(result)
      if (paymentRequired) return retryWithPayment(params, call, paymentRequired, result)
      return withReceipt(result)
    } catch (error) {
      if (!isPaymentRequiredError(error)) throw error
      return retryWithPayment(params, call, error.data, error)
    }
  }
}

function getPaymentRequiredMeta(
  result: Awaited<ReturnType<Client['callTool']>>,
): PaymentRequiredData | undefined {
  const data = result._meta?.[core_Mcp.paymentRequiredMetaKey]
  return isPaymentRequiredData(data) ? data : undefined
}

function isPaymentRequiredData(value: unknown): value is PaymentRequiredData {
  return PaymentRequiredSchema.safeParse(value).success
}

function withReceipt(result: Awaited<ReturnType<Client['callTool']>>): CallToolResult {
  return {
    ...result,
    receipt: result._meta?.[core_Mcp.receiptMetaKey] as core_Mcp.Receipt | undefined,
  }
}

/** Union of all context types from all methods that have context schemas. */
type AnyContextFor<methods extends readonly AnyClient[]> = {
  [key in keyof methods]: methods[key] extends Method.Client<any, infer context>
    ? context extends z.ZodMiniType
      ? z.input<context>
      : undefined
    : undefined
}[number]

/** Union of all context types across a methods config, flattening tuples. @internal */
type AnyContextForMethods<methods extends Methods> =
  FlattenMethods<methods> extends infer flattened extends readonly AnyClient[]
    ? AnyContextFor<flattened>
    : never

type FlattenMethods<methods extends Methods> = methods extends readonly [
  infer head,
  ...infer tail extends Methods,
]
  ? head extends readonly Method.AnyClient[]
    ? readonly [...head, ...FlattenMethods<tail>]
    : head extends Method.AnyClient
      ? readonly [head, ...FlattenMethods<tail>]
      : never
  : readonly []
