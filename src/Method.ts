import type * as Challenge from './Challenge.js'
import * as Constants from './Constants.js'
import * as Credential from './Credential.js'
import * as Errors from './Errors.js'
import * as Expires from './Expires.js'
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
  canHandleChallenge?: CanHandleChallengeFn | undefined
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

/** Validation hook parameters for a single method. */
export type ValidateContext<method extends Method> = VerifyContext<method>

/** Response hook parameters for a single method. */
export type RespondContext<method extends Method> = VerifyContext<method> & {
  input: globalThis.Request
  receipt: Receipt.Receipt
}

/** Non-mutating method-specific validation result. */
export type Validation<method extends Method = Method, details = unknown> = Readonly<{
  challenge: Challenge.Challenge<
    z.output<method['schema']['request']>,
    method['intent'],
    method['name']
  >
  credential: Credential.Credential<
    z.output<method['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<method['schema']['request']>, method['intent'], method['name']>
  >
  details: details
  intent: method['intent']
  method: method['name']
  request: z.output<method['schema']['request']>
  source?: string | undefined
}>

/**
 * A server-side configured method with verification logic.
 */
export type Server<
  method extends Method = Method,
  defaults extends ExactPartial<z.input<method['schema']['request']>> = {},
  transportOverride = undefined,
  extensions extends object = {},
  alias extends string | undefined = string | undefined,
> = method & {
  alias?: alias | undefined
  authorize?: AuthorizeFn<method> | undefined
  defaults?: defaults | undefined
  extensions?: extensions | undefined
  html?: Html.Options | undefined
  preflight?: PreflightFn<method> | undefined
  request?: RequestFn<method> | undefined
  respond?: RespondFn<method> | undefined
  broadcast?: BroadcastFn<method> | undefined
  stableBinding?: StableBindingFn<method> | undefined
  transport?: transportOverride | undefined
  validate?: ValidateFn<method> | undefined
  /** @deprecated Implement `broadcast` for new methods. */
  verify: VerifyFn<method>
}
export type AnyServer = Server<any, any, any, any, any>

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

/** Predicate used when multiple client implementations share a wire method/intent. */
export type CanHandleChallengeFn = (parameters: { challenge: Challenge.Challenge }) => boolean

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
 *
 * Transports that require credential context for `withReceipt()` should return a
 * `response` from this hook so adapters can short-circuit protected handlers.
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
 * Optional HTTP preflight hook for method-specific management requests.
 *
 * Called before the normal challenge/verification path. Returning a response
 * fully handles the request.
 */
export type PreflightFn<method extends Method> = (parameters: {
  capturedRequest?: CapturedRequest | undefined
  credential: Credential.Credential | null
  expires?: string | undefined
  input: globalThis.Request
  options: z.input<method['schema']['request']>
  realm: string
  secretKey: string
}) => MaybePromise<globalThis.Response | undefined>

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

/** Non-mutating validation function for a single method. */
export type ValidateFn<method extends Method> = (
  parameters: ValidateContext<method>,
) => Promise<Validation<method>>

/** Terminal payment function for a single method. */
export type BroadcastFn<method extends Method> = (
  parameters: VerifyContext<method>,
) => Promise<Receipt.Receipt>

/**
 * Validates a credential against one of the configured methods.
 *
 * This checks credential structure, challenge expiry, and method-specific
 * validation. It does not prove that the challenge was issued by a particular
 * server; hosts that issue challenges must verify that binding separately.
 */
export async function validateCredential<const methods extends readonly AnyServer[]>(
  methods: methods,
  input: string | Credential.Credential,
): Promise<Validation<methods[number]>> {
  const prepared = prepareCredential(methods, input)
  if (!prepared.method.validate)
    throw new Errors.VerificationFailedError({
      details: { intent: prepared.method.intent, method: prepared.method.name },
      reason: `${prepared.method.name}/${prepared.method.intent} does not support non-mutating credential validation`,
    })
  return prepared.method.validate({
    credential: prepared.credential,
    request: prepared.request,
  } as never) as Promise<Validation<methods[number]>>
}

/**
 * Re-validates and performs the terminal payment operation for a credential.
 *
 * This does not prove that the challenge was issued by a particular server;
 * hosts that issue challenges must verify that binding separately.
 */
export async function broadcastCredential<const methods extends readonly AnyServer[]>(
  methods: methods,
  input: string | Credential.Credential,
): Promise<Receipt.Receipt> {
  const prepared = prepareCredential(methods, input)
  const { method } = prepared

  if (method.broadcast && method.validate)
    await method.validate({ credential: prepared.credential, request: prepared.request } as never)

  const broadcast = method.broadcast ?? method.verify
  return broadcast({ credential: prepared.credential, request: prepared.request } as never)
}

/**
 * Parses a submitted credential into the inputs required for method execution.
 *
 * Dispatch is based on the challenge method and intent. When more than one
 * server method handles the same wire identity, session protocol details select
 * the appropriate implementation. The helper then asserts challenge expiry and
 * parses the method-specific credential payload before returning the selected
 * method and the unmodified challenge request.
 *
 * This intentionally does not verify that the challenge was issued by a
 * particular host, authorize the caller or requested resource, validate the
 * method request, or invoke method lifecycle hooks. Hosts that issue challenges
 * must verify their challenge binding before accepting the credential.
 */
function prepareCredential(
  methods: readonly AnyServer[],
  input: string | Credential.Credential,
): {
  credential: Credential.Credential
  method: AnyServer
  request: Record<string, unknown>
} {
  const credential = typeof input === 'string' ? Credential.deserialize(input) : input
  const candidates = methods.filter(
    (method) =>
      method.name === credential.challenge.method && method.intent === credential.challenge.intent,
  )
  const method = selectServerMethod(candidates, credential.challenge)
  if (!method)
    throw new Errors.InvalidChallengeError({
      id: credential.challenge.id,
      reason: `no registered method for ${credential.challenge.method}/${credential.challenge.intent}`,
    })

  Expires.assert(credential.challenge.expires, credential.challenge.id)

  let payload: unknown
  try {
    payload = method.schema.credential.payload.parse(credential.payload)
  } catch (error) {
    throw new Errors.InvalidPayloadError(error instanceof Error ? { reason: error.message } : {})
  }

  return {
    credential: { ...credential, payload },
    method,
    request: credential.challenge.request,
  }
}

/** @internal */
export function selectServerMethod(
  methods: readonly AnyServer[],
  challenge: Challenge.Challenge,
): AnyServer | undefined {
  if (methods.length <= 1) return methods[0]
  if (
    challenge.method !== Constants.Methods.tempo ||
    challenge.intent !== Constants.Intents.session
  )
    return methods[0]

  const sessionProtocol = Constants.getMethodDetail(
    challenge.request.methodDetails,
    Constants.MethodDetailKeys.sessionProtocol,
  )
  if (sessionProtocol === undefined || sessionProtocol === Constants.SessionProtocols.v1)
    return methods.find((method) => method.alias === 'sessionLegacy') ?? methods[0]
  if (sessionProtocol === Constants.SessionProtocols.v2)
    return methods.find((method) => method.alias === undefined) ?? methods[0]
  return undefined
}

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
  const { canHandleChallenge, context, createCredential } = options
  return {
    ...method,
    canHandleChallenge,
    context,
    createCredential,
  } as Client<method, context>
}

export declare namespace toClient {
  type Options<method extends Method, context extends z.ZodMiniType | undefined = undefined> = {
    canHandleChallenge?: CanHandleChallengeFn | undefined
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
  const extensions extends object = {},
  const options extends toServer.Options<
    method,
    defaults,
    transportOverride,
    extensions,
    string | undefined
  > = toServer.Options<method, defaults, transportOverride, extensions, string | undefined>,
>(
  method: method,
  options: options,
): Server<method, defaults, transportOverride, extensions, toServer.Alias<options>> {
  const {
    alias,
    authorize,
    defaults,
    extensions,
    html,
    preflight,
    request,
    respond,
    broadcast,
    stableBinding,
    transport,
    validate,
    verify,
  } = options
  const effectiveVerify =
    verify ??
    (async (parameters: VerifyContext<method>) => {
      if (validate) await validate(parameters)
      if (!broadcast)
        throw new Errors.VerificationFailedError({
          reason: `${method.name}/${method.intent} does not support credential broadcast`,
        })
      return broadcast(parameters)
    })
  return {
    ...method,
    alias,
    authorize,
    defaults,
    extensions,
    html,
    preflight,
    request,
    respond,
    broadcast,
    stableBinding,
    transport,
    validate,
    verify: effectiveVerify,
  } as Server<method, defaults, transportOverride, extensions, toServer.Alias<options>>
}

export declare namespace toServer {
  type Alias<options> = options extends { alias: infer alias extends string } ? alias : undefined

  type Options<
    method extends Method,
    defaults extends RequestDefaults<method> = {},
    transportOverride extends Transport.AnyTransport | undefined = undefined,
    extensions extends object = {},
    alias extends string | undefined = undefined,
  > = {
    alias?: alias | undefined
    authorize?: AuthorizeFn<method> | undefined
    defaults?: defaults | undefined
    extensions?: extensions | undefined
    html?: Html.Options | undefined
    preflight?: PreflightFn<method> | undefined
    request?: RequestFn<method> | undefined
    respond?: RespondFn<method> | undefined
    stableBinding?: StableBindingFn<method> | undefined
    transport?: transportOverride | Transport.AnyTransport | undefined
    validate?: ValidateFn<method> | undefined
  } & (
    | {
        broadcast: BroadcastFn<method>
        /** @deprecated Implement `broadcast` for new methods. */
        verify?: VerifyFn<method> | undefined
      }
    | {
        broadcast?: undefined
        verify: VerifyFn<method>
      }
  )
}
