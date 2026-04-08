import type * as Challenge from './Challenge.js'
import type * as Credential from './Credential.js'
import type { ExactPartial, LooseOmit, MaybePromise } from './internal/types.js'
import type * as Receipt from './Receipt.js'
import type * as Html from './server/internal/html/config.js'
import type * as Transport from './server/Transport.js'
import type * as z from './zod.js'

/**
 * A payment method.
 */
export type Method = {
  name: string
  html?: Html.Options | undefined
  intent: string
  schema: {
    credential: {
      payload: z.ZodMiniType
    }
    request: z.ZodMiniType<Record<string, unknown>>
  }
}

/**
 * Creates a payment method.
 *
 * @example
 * ```ts
 * import { z } from 'zod/mini'
 * import { Method } from 'mppx'
 *
 * const tempoCharge = Method.from({
 *   name: 'tempo',
 *   intent: 'charge',
 *   schema: {
 *     credential: {
 *       payload: z.object({
 *         signature: z.string(),
 *         type: z.literal('transaction'),
 *       }),
 *     },
 *     request: z.object({
 *       amount: z.string(),
 *       currency: z.string(),
 *       recipient: z.string(),
 *     }),
 *   },
 * })
 * ```
 */
export function from<const method extends Method>(method: method): method {
  return method
}

/**
 * A client-side configured method with credential creation logic.
 */
export type Client<
  method extends Method = Method,
  context extends z.ZodMiniType | undefined = z.ZodMiniType | undefined,
> = method & {
  context?: context
  createCredential: CreateCredentialFn<
    method,
    context extends z.ZodMiniType ? z.output<context> : Record<never, never>
  >
}
export type AnyClient = Client<any, any>

/**
 * Protocol-level facts the core always binds across methods.
 */
export type CoreBinding = {
  readonly amount?: string
  readonly currency?: string
  readonly recipient?: string
}

/**
 * Method-specific pinned fields that the core compares and passes through
 * additively without interpreting generically.
 */
export type MethodBinding = {
  readonly chainId?: string
  readonly memo?: string
  readonly splits?: unknown
}

/**
 * Immutable projection of the challenge-bound request parameters split into
 * core protocol bindings and method-specific bindings.
 *
 * The core only reasons about `coreBinding` directly. `methodBinding` stays an
 * opaque passthrough for comparison and method hooks.
 */
export type PinnedRequestBinding = {
  readonly coreBinding: CoreBinding
  readonly methodBinding: MethodBinding
}

/** Shared constructor for the normalized request fields the core pins. */
export const PinnedRequestBinding = {
  from(request: Record<string, unknown>): PinnedRequestBinding {
    const methodDetails = (request.methodDetails ?? {}) as Record<string, unknown>
    const amount = normalizeScalar(request.amount ?? methodDetails.amount)
    const chainId = normalizeScalar(request.chainId ?? methodDetails.chainId)
    const currency = normalizeScalar(request.currency ?? methodDetails.currency)
    const memo = normalizeHex(methodDetails.memo)
    const recipient = normalizeScalar(request.recipient ?? methodDetails.recipient)
    const splits = normalizeComparable(methodDetails.splits)

    return Object.freeze({
      coreBinding: Object.freeze({
        ...(amount !== undefined ? { amount } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(recipient !== undefined ? { recipient } : {}),
      }) as CoreBinding,
      methodBinding: Object.freeze({
        ...(chainId !== undefined ? { chainId } : {}),
        ...(memo !== undefined ? { memo } : {}),
        ...(splits !== undefined ? { splits: deepFreeze(splits) } : {}),
      }) as MethodBinding,
    }) as PinnedRequestBinding
  },
} as const

/** Transport-captured request metadata used as the authoritative request snapshot. */
export type CapturedRequest = {
  readonly headers: Headers
  readonly method: string
  readonly url: URL
}

/** Verified challenge + credential pair, bound to the captured request snapshot. */
export type VerifiedChallengeEnvelope<
  request extends Record<string, unknown> = Record<string, unknown>,
  payload = unknown,
  intent extends string = string,
  MethodName extends string = string,
> = {
  readonly capturedRequest: CapturedRequest
  readonly challenge: Challenge.Challenge<request, intent, MethodName>
  readonly credential: Credential.Credential<
    payload,
    Challenge.Challenge<request, intent, MethodName>
  >
}

/** Authoritative verified context shared across verification and response hooks. */
export type VerifiedPaymentContext<
  request extends Record<string, unknown> = Record<string, unknown>,
  payload = unknown,
  binding = MethodBinding,
  intent extends string = string,
  MethodName extends string = string,
> = {
  readonly coreBinding: CoreBinding
  readonly envelope: VerifiedChallengeEnvelope<request, payload, intent, MethodName>
  readonly methodBinding: binding
}

type VerifiedPaymentContextOf<
  method extends Method,
  binding = MethodBinding,
> = VerifiedPaymentContext<
  z.output<method['schema']['request']>,
  z.output<method['schema']['credential']['payload']>,
  binding,
  method['intent'],
  method['name']
>

/** Request hook parameters for a single method. */
export type RequestContext<method extends Method> = {
  capturedRequest?: CapturedRequest
  credential?: Credential.Credential | null
  request: z.input<method['schema']['request']>
}

/** Verification hook parameters for a single method. */
export type VerifyContext<method extends Method, binding = MethodBinding> = {
  credential: Credential.Credential<
    z.output<method['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<method['schema']['request']>, method['intent'], method['name']>
  >
  request: z.input<method['schema']['request']>
} & Partial<VerifiedPaymentContextOf<method, binding>>

/** Response hook parameters for a single method. */
export type RespondContext<method extends Method, binding = MethodBinding> = VerifyContext<
  method,
  binding
> & {
  input: globalThis.Request
  receipt: Receipt.Receipt
}

/**
 * A server-side configured method with verification logic.
 */
export type Server<
  method extends Method = Method,
  defaults extends ExactPartial<z.input<method['schema']['request']>> = {},
  transportOverride = undefined,
> = method & {
  defaults?: defaults | undefined
  html?: Html.Options | undefined
  request?: RequestFn<method> | undefined
  respond?: RespondFn<method> | undefined
  transport?: transportOverride | undefined
  verify: VerifyFn<method>
}
export type AnyServer = Server<any, any, any>

/** Credential creation function for a single method. */
export type CreateCredentialFn<method extends Method, context = unknown> = (
  parameters: {
    challenge: Challenge.Challenge<
      z.output<method['schema']['request']>,
      method['intent'],
      method['name']
    >
  } & ([keyof context] extends [never] ? unknown : { context: context }),
) => Promise<string>

/** Request transform function for a single method. */
export type RequestFn<method extends Method> = (
  options: RequestContext<method>,
) => MaybePromise<z.input<method['schema']['request']>>

/** Verification function for a single method. */
export type VerifyFn<method extends Method> = (
  parameters: VerifyContext<method>,
) => Promise<Receipt.Receipt>

/**
 * Optional respond function for a server-side method.
 *
 * Called after `verify` succeeds. If it returns a `Response`, the library
 * treats the request as fully handled (e.g. channel open/close) and
 * `withReceipt()` will short-circuit — returning the management response
 * with the receipt header attached without invoking any user-supplied
 * response or generator. If it returns `undefined`, the server handler
 * is expected to serve content via `withReceipt(response)`.
 *
 * **HTTP-only.** The `input` parameter is a `Request` object; MCP transports
 * do not invoke this hook.
 */
export type RespondFn<method extends Method> = (
  parameters: RespondContext<method>,
) => MaybePromise<globalThis.Response | undefined>

/** Partial request type for defaults. */
export type RequestDefaults<method extends Method> = ExactPartial<
  z.input<method['schema']['request']>
>

/** Makes fields optional if they exist in defaults. */
export type WithDefaults<request, defaults> = [keyof defaults] extends [never]
  ? request
  : LooseOmit<request, keyof defaults & string> &
      ExactPartial<Pick<request, keyof defaults & keyof request>>

/**
 * Extends a method with client-side credential creation logic.
 *
 * @example
 * ```ts
 * import { Method } from 'mppx'
 * import { Methods } from 'mppx/tempo'
 *
 * const tempoCharge = Method.toClient(Methods.charge, {
 *   async createCredential({ challenge }) {
 *     return Credential.serialize({ challenge, payload: { ... } })
 *   },
 * })
 * ```
 */
export function toClient<
  const method extends Method,
  const context extends z.ZodMiniType | undefined = undefined,
>(method: method, options: toClient.Options<method, context>): Client<method, context> {
  const { context, createCredential } = options
  return {
    ...method,
    context,
    createCredential,
  } as Client<method, context>
}

export declare namespace toClient {
  type Options<method extends Method, context extends z.ZodMiniType | undefined = undefined> = {
    context?: context
    createCredential: CreateCredentialFn<
      method,
      context extends z.ZodMiniType ? z.output<context> : Record<never, never>
    >
  }
}

/**
 * Extends a method with server-side verification logic.
 *
 * @example
 * ```ts
 * import { Method } from 'mppx'
 * import { Methods } from 'mppx/tempo'
 *
 * const tempoCharge = Method.toServer(Methods.charge, {
 *   async verify({ credential }) {
 *     // verification logic
 *     return { status: 'success', ... }
 *   },
 * })
 * ```
 */
export function toServer<
  const method extends Method,
  const defaults extends RequestDefaults<method> = {},
  const transportOverride extends Transport.AnyTransport | undefined = undefined,
>(
  method: method,
  options: toServer.Options<method, defaults, transportOverride>,
): Server<method, defaults, transportOverride> {
  const { defaults, html, request, respond, transport, verify } = options
  return {
    ...method,
    defaults,
    html,
    request,
    respond,
    transport,
    verify,
  } as Server<method, defaults, transportOverride>
}

export declare namespace toServer {
  type Options<
    method extends Method,
    defaults extends RequestDefaults<method> = {},
    transportOverride extends Transport.AnyTransport | undefined = undefined,
  > = {
    defaults?: defaults | undefined
    html?: Html.Options | undefined
    request?: RequestFn<method> | undefined
    respond?: RespondFn<method> | undefined
    transport?: transportOverride | undefined
    verify: VerifyFn<method>
  }
}

function normalizeScalar(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value)
}

function normalizeHex(value: unknown): string | undefined {
  if (value === undefined) return undefined

  const normalized = String(value)
  return normalized.startsWith('0x') ? normalized.toLowerCase() : normalized
}

function normalizeComparable(value: unknown): unknown {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map(normalizeComparable)

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeComparable(nested)]),
    )
  }

  return typeof value === 'string' ? normalizeHex(value) : value
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry)
    return Object.freeze(value)
  }

  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
    return Object.freeze(value)
  }

  return value
}
