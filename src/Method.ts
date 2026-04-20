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

/** Transport-captured request metadata used as the authoritative request snapshot. */
export type CapturedRequest = {
  readonly hasBody?: boolean | undefined
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
  /** The authoritative route request after defaults and request-hook transforms. */
  readonly request: request
}

/** Request hook parameters for a single method. */
export type RequestContext<method extends Method> = {
  capturedRequest?: CapturedRequest
  credential?: Credential.Credential | null
  request: z.input<method['schema']['request']>
}

/** Verification hook parameters for a single method. */
export type VerifyContext<method extends Method> = {
  credential: Credential.Credential<
    z.output<method['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<method['schema']['request']>, method['intent'], method['name']>
  >
  envelope?:
    | VerifiedChallengeEnvelope<
        z.output<method['schema']['request']>,
        z.output<method['schema']['credential']['payload']>,
        method['intent'],
        method['name']
      >
    | undefined
  request: z.input<method['schema']['request']>
}

/** Response hook parameters for a single method. */
export type RespondContext<method extends Method> = VerifyContext<method> & {
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
  authorize?: AuthorizeFn<method> | undefined
  defaults?: defaults | undefined
  html?: Html.Options | undefined
  request?: RequestFn<method> | undefined
  respond?: RespondFn<method> | undefined
  stableBinding?: StableBindingFn<method> | undefined
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

/**
 * Optional authorization hook for a server-side method.
 *
 * Called after request normalization but before the 402 challenge path. This lets
 * a server grant access based on existing application state (for example, an
 * active subscription) without requiring a fresh `Payment` credential.
 *
 * **HTTP-only.** The `input` parameter is a Fetch `Request`; non-HTTP transports
 * do not invoke this hook.
 */
export type AuthorizeFn<method extends Method> = (parameters: {
  challenge: Challenge.Challenge<
    z.output<method['schema']['request']>,
    method['intent'],
    method['name']
  >
  input: globalThis.Request
  request: z.output<method['schema']['request']>
}) => MaybePromise<AuthorizeResult | undefined>

/** Successful result returned from an {@link AuthorizeFn}. */
export type AuthorizeResult = {
  receipt: Receipt.Receipt
  response?: globalThis.Response | undefined
}

/**
 * Produces the stable request fields used to bind credentials to a route.
 *
 * Methods can override this to opt into additional request fields beyond the
 * default amount/currency/recipient binding used by generic methods.
 */
export type StableBindingFn<method extends Method> = (
  request: z.output<method['schema']['request']>,
) => Record<string, unknown>

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
 * Use `parameters.envelope?.capturedRequest` for any transport-agnostic
 * authorization, billing, or routing decisions. The raw `input` should only
 * be used for transport-specific response shaping (for example, HTTP content
 * negotiation).
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
  const { authorize, defaults, html, request, respond, stableBinding, transport, verify } = options
  return {
    ...method,
    authorize,
    defaults,
    html,
    request,
    respond,
    stableBinding,
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
    authorize?: AuthorizeFn<method> | undefined
    defaults?: defaults | undefined
    html?: Html.Options | undefined
    request?: RequestFn<method> | undefined
    respond?: RespondFn<method> | undefined
    stableBinding?: StableBindingFn<method> | undefined
    transport?: transportOverride | undefined
    verify: VerifyFn<method>
  }
}
