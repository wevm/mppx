import type * as BodyDigest from './BodyDigest.js'
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

/** Minimum economic facts the core always binds. */
export type CoreBinding = {
  amount?: string | undefined
  currency?: string | undefined
  recipient?: string | undefined
}

/** Transport-captured request metadata used as the authoritative request snapshot. */
export type CapturedRequest = {
  bodyBytes?: Uint8Array | undefined
  bodyDigest?: BodyDigest.BodyDigest | undefined
  headers: Headers
  method: string
  url: URL
}

/** Verified challenge + credential pair, bound to the captured request snapshot. */
export type VerifiedChallengeEnvelope<
  request extends Record<string, unknown> = Record<string, unknown>,
  payload = unknown,
  intent extends string = string,
  method_name extends string = string,
> = {
  capturedRequest: CapturedRequest
  challenge: Challenge.Challenge<request, intent, method_name>
  credential: Credential.Credential<payload, Challenge.Challenge<request, intent, method_name>>
}

/** Authoritative verified context shared across post-verification hooks. */
export type VerifiedPaymentContext<
  request extends Record<string, unknown> = Record<string, unknown>,
  payload = unknown,
  binding = Record<string, unknown>,
  intent extends string = string,
  method_name extends string = string,
> = {
  coreBinding: CoreBinding
  envelope: VerifiedChallengeEnvelope<request, payload, intent, method_name>
  methodBinding: binding
}

type VerifiedPaymentContextOf<
  method extends Method,
  binding = Record<string, unknown>,
> = VerifiedPaymentContext<
  z.output<method['schema']['request']>,
  z.output<method['schema']['credential']['payload']>,
  binding,
  method['intent'],
  method['name']
>

/** Pre-challenge request derivation hook. */
export type ChallengeContext<method extends Method> = {
  capturedRequest: CapturedRequest
  request: z.input<method['schema']['request']>
}

/** Post-verification request resolution hook. */
export type RequestContext<
  method extends Method,
  binding = Record<string, unknown>,
> = VerifiedPaymentContextOf<method, binding> & {
  requestInput: z.input<method['schema']['request']>
}

/** Context passed to verification hooks. */
export type VerifyContext<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = VerifiedPaymentContextOf<method, binding> & {
  request: request
}

/** Context passed to respond hooks. */
export type RespondContext<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = VerifyContext<method, request, binding> & {
  receipt: Receipt.Receipt
}

/**
 * A server-side configured method with verification logic.
 */
export type Server<
  method extends Method = Method,
  defaults extends ExactPartial<z.input<method['schema']['request']>> = {},
  transportOverride = undefined,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = method & {
  challenge?: ChallengeFn<method> | undefined
  defaults?: defaults | undefined
  html?: Html.Options | undefined
  request?: RequestFn<method, request, binding> | undefined
  respond?: ServerRespondFn<method, request, binding> | undefined
  transport?: transportOverride | undefined
  verify: ServerVerifyFn<method, request, binding>
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

/** Pre-challenge request derivation function for a single method. */
export type ChallengeFn<method extends Method> = (
  context: ChallengeContext<method>,
) => MaybePromise<z.input<method['schema']['request']>>

/** Post-verification request resolution function for a single method. */
export type RequestFn<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = (context: RequestContext<method, binding>) => MaybePromise<request>

/** Verification function for a single method. */
export type VerifyFn<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = (context: VerifyContext<method, request, binding>) => Promise<Receipt.Receipt>

type LegacyVerifyParameters<method extends Method> = {
  credential: Credential.Credential<
    z.output<method['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<method['schema']['request']>, method['intent'], method['name']>
  >
  request: z.input<method['schema']['request']>
}

/**
 * Public verify function exposed on configured server methods.
 *
 * Hook implementations receive the verified context shape. The legacy
 * `{ credential, request }` call signature remains available on the returned
 * server object so direct method tests can construct a synthetic verified
 * context without going through `Mppx.create()`.
 */
export type ServerVerifyFn<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = VerifyFn<method, request, binding> &
  ((parameters: LegacyVerifyParameters<method>) => Promise<Receipt.Receipt>)

/**
 * Optional respond function for a server-side method.
 *
 * Called after `verify` succeeds. If it returns a `Response`, the library
 * treats the request as fully handled (e.g. channel open/close) and
 * `withReceipt()` will short-circuit — returning the management response
 * with the receipt header attached without invoking any user-supplied
 * response or generator. If it returns `undefined`, the server handler
 * is expected to serve content via `withReceipt(response)`.
 */
export type RespondFn<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = (
  context: RespondContext<method, request, binding>,
) => MaybePromise<globalThis.Response | undefined>

type LegacyRespondParameters<
  method extends Method,
  request = z.output<method['schema']['request']>,
> = {
  credential: Credential.Credential<
    z.output<method['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<method['schema']['request']>, method['intent'], method['name']>
  >
  input: unknown
  receipt: Receipt.Receipt
  request: request
}

export type ServerRespondFn<
  method extends Method,
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
> = RespondFn<method, request, binding> &
  ((
    parameters: LegacyRespondParameters<method, request>,
  ) => MaybePromise<globalThis.Response | undefined>)

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
 *   async verify({ envelope }) {
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
  request = z.output<method['schema']['request']>,
  binding = Record<string, unknown>,
>(
  method: method,
  options: toServer.Options<method, defaults, transportOverride, request, binding>,
): Server<method, defaults, transportOverride, request, binding> {
  const { challenge, defaults, html, request, respond, transport, verify } = options
  const wrappedVerify = (async (
    parameters: VerifyContext<method, request, binding> | LegacyVerifyParameters<method>,
  ) => {
    if (isVerifyContext(parameters)) return verify(parameters)

    const context = legacyVerifyContext<method, binding>(parameters)
    const resolvedRequest = request
      ? await request({ ...context, requestInput: parameters.request })
      : (parameters.request as request)
    return verify({ ...context, request: resolvedRequest })
  }) as ServerVerifyFn<method, request, binding>

  const wrappedRespond = respond
    ? (((
        parameters:
          | RespondContext<method, request, binding>
          | LegacyRespondParameters<method, request>,
      ) => {
        if (isRespondContext(parameters)) return respond(parameters)

        const context = legacyVerifyContext<method, binding>(
          {
            credential: parameters.credential,
            request: parameters.request as z.input<method['schema']['request']>,
          },
          captureRequestFromInput(parameters.input),
        )
        return respond({ ...context, receipt: parameters.receipt, request: parameters.request })
      }) as ServerRespondFn<method, request, binding>)
    : undefined

  return {
    ...method,
    challenge,
    defaults,
    html,
    request,
    respond: wrappedRespond,
    transport,
    verify: wrappedVerify,
  } as Server<method, defaults, transportOverride, request, binding>
}

export declare namespace toServer {
  type Options<
    method extends Method,
    defaults extends RequestDefaults<method> = {},
    transportOverride extends Transport.AnyTransport | undefined = undefined,
    request = z.output<method['schema']['request']>,
    binding = Record<string, unknown>,
  > = {
    challenge?: ChallengeFn<method> | undefined
    defaults?: defaults | undefined
    html?: Html.Options | undefined
    request?: RequestFn<method, request, binding> | undefined
    respond?: RespondFn<method, request, binding> | undefined
    transport?: transportOverride | undefined
    verify: VerifyFn<method, request, binding>
  }
}

function isVerifyContext<method extends Method, request, binding>(
  parameters: VerifyContext<method, request, binding> | LegacyVerifyParameters<method>,
): parameters is VerifyContext<method, request, binding> {
  return 'envelope' in parameters
}

function isRespondContext<method extends Method, request, binding>(
  parameters: RespondContext<method, request, binding> | LegacyRespondParameters<method, request>,
): parameters is RespondContext<method, request, binding> {
  return 'envelope' in parameters
}

function legacyVerifyContext<method extends Method, binding = Record<string, unknown>>(
  parameters: LegacyVerifyParameters<method>,
  capturedRequest: CapturedRequest = {
    headers: new Headers(),
    method: 'POST',
    url: new URL('about:blank'),
  },
): VerifiedPaymentContextOf<method, binding> {
  const request = parameters.credential.challenge.request as Record<string, unknown>
  return {
    coreBinding: {
      amount: scalarBinding(request.amount ?? getMethodDetailsValue(request, 'amount')),
      currency: scalarBinding(request.currency ?? getMethodDetailsValue(request, 'currency')),
      recipient: scalarBinding(request.recipient ?? getMethodDetailsValue(request, 'recipient')),
    },
    envelope: {
      capturedRequest,
      challenge: parameters.credential.challenge,
      credential: parameters.credential,
    },
    methodBinding: {
      chainId: getMethodDetailsValue(request, 'chainId'),
      memo: getMethodDetailsValue(request, 'memo'),
      splits: getMethodDetailsValue(request, 'splits'),
    } as binding,
  }
}

function getMethodDetailsValue(
  request: Record<string, unknown>,
  key: 'amount' | 'chainId' | 'currency' | 'memo' | 'recipient' | 'splits',
): unknown {
  const methodDetails = (request.methodDetails ?? {}) as Record<string, unknown>
  return methodDetails[key]
}

function scalarBinding(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value)
}

function captureRequestFromInput(input: unknown): CapturedRequest {
  const source = input as {
    headers?: HeadersInit | undefined
    method?: string | undefined
    url?: string | undefined
  }
  return {
    headers: new Headers(source.headers),
    method: source.method ?? 'POST',
    url: safeUrl(source.url),
  }
}

function safeUrl(url: string | undefined): URL {
  try {
    if (url) return new URL(url)
  } catch {}
  return new URL('about:blank')
}
