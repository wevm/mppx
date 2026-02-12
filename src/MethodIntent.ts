import type * as Challenge from './Challenge.js'
import type * as Credential from './Credential.js'
import * as Intent from './Intent.js'
import type { ExactPartial, LooseOmit, MaybePromise } from './internal/types.js'
import type * as Receipt from './Receipt.js'
import type * as Transport from './server/Transport.js'
import * as z from './zod.js'

/**
 * A payment method-specific intent.
 */
export type MethodIntent<
  intent extends Intent.Intent = Intent.Intent,
  options extends fromIntent.Options<intent> = fromIntent.Options<intent>,
> = {
  method: options['method']
  name: intent['name']
  schema: {
    credential: {
      payload: options['schema']['credential']['payload']
    }
    request: MergedRequestSchema<intent, options>
  }
}
export type AnyMethodIntent = MethodIntent<any, any>

/**
 * Creates a method-specific intent.
 *
 * @example
 * ```ts
 * import { z } from 'zod/mini'
 * import { MethodIntent } from 'mpay'
 *
 * const tempoCharge = MethodIntent.from({
 *   method: 'tempo',
 *   name: 'charge',
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
export function from<const intent extends MethodIntent>(intent: intent): intent {
  return intent
}

/**
 * Creates a method-specific intent from a base intent.
 *
 * @example
 * ```ts
 * import { z } from 'zod/mini'
 * import { Intent, MethodIntent } from 'mpay'
 *
 * const tempoCharge = MethodIntent.fromIntent(Intent.charge, {
 *   method: 'tempo',
 *   schema: {
 *     credential: {
 *       payload: z.object({
 *         signature: z.string(),
 *         type: z.literal('transaction'),
 *       }),
 *     },
 *     request: {
 *       methodDetails: z.object({
 *         chainId: z.number(),
 *       }),
 *       requires: ['recipient'],
 *     },
 *   },
 * })
 * ```
 */
export function fromIntent<
  const intent extends Intent.Intent,
  const options extends fromIntent.Options<intent>,
>(intent: intent, options: options): MethodIntent<intent, options> {
  const { name } = intent
  const { method, schema } = options

  const requestShape = Intent.shapeOf(intent) as Record<string, z.ZodMiniType>

  const methodDetails = schema.request?.methodDetails
  const requires = schema.request?.requires ?? []

  const requestInputShape: Record<string, z.ZodMiniType> = {}
  for (const [key, field] of Object.entries(requestShape)) {
    if (requires.includes(key as never)) requestInputShape[key] = z.unwrapOptional(field)
    else requestInputShape[key] = field
  }

  const methodDetailsKeys: string[] = []
  if (methodDetails)
    for (const [key, field] of Object.entries(
      methodDetails.shape as Record<string, z.ZodMiniType>,
    )) {
      requestInputShape[key] = field
      methodDetailsKeys.push(key)
    }

  const intentRequest = intent.schema.request
  const hasPipe = !('shape' in intentRequest)

  const request = z.pipe(
    z.object(requestInputShape),
    z.transform((input: Record<string, unknown>) => {
      const transformed = hasPipe ? (intentRequest as z.ZodMiniType).parse(input) : input

      const result: Record<string, unknown> = {}
      const details: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(transformed as Record<string, unknown>)) {
        result[key] = value
      }

      for (const key of methodDetailsKeys) {
        const value = input[key]
        if (value !== undefined) details[key] = value
      }

      if (Object.keys(details).length > 0) result.methodDetails = details
      return result
    }),
  )

  return {
    method,
    name,
    schema: {
      credential: { payload: schema.credential.payload },
      request,
    },
  } as unknown as MethodIntent<intent, options>
}

export namespace fromIntent {
  export type Options<intent extends Intent.Intent> = {
    method: string
    schema: {
      credential: { payload: z.ZodMiniType }
      request?:
        | {
            methodDetails?: z.ZodMiniObject | undefined
            requires?: readonly (keyof Intent.ShapeOf<intent>)[] | undefined
          }
        | undefined
    }
  }
}

/** @internal */
type RequiresKeys<
  intent extends Intent.Intent,
  options extends fromIntent.Options<intent>,
> = options['schema']['request'] extends { requires: readonly (infer key)[] } ? key : never

/** @internal */
type UnwrapOptional<schema> = schema extends z.ZodMiniOptional<infer inner> ? inner : schema

/** @internal */
type MethodDetailsShape<
  intent extends Intent.Intent,
  options extends fromIntent.Options<intent>,
> = options['schema']['request'] extends { methodDetails: infer details extends z.ZodMiniObject }
  ? details['shape']
  : Record<never, never>

/** @internal */
type InputRequestShape<intent extends Intent.Intent, options extends fromIntent.Options<intent>> = {
  [K in keyof Intent.ShapeOf<intent>]: K extends RequiresKeys<intent, options>
    ? UnwrapOptional<Intent.ShapeOf<intent>[K]>
    : Intent.ShapeOf<intent>[K]
} & MethodDetailsShape<intent, options>

/** @internal */
type MethodDetailsOutput<
  intent extends Intent.Intent,
  options extends fromIntent.Options<intent>,
> = options['schema']['request'] extends { methodDetails: infer details extends z.ZodMiniObject }
  ? { methodDetails?: z.output<details> }
  : Record<never, never>

/** @internal */
type OutputRequestType<intent extends Intent.Intent, options extends fromIntent.Options<intent>> = {
  [K in keyof Intent.ShapeOf<intent>]: K extends RequiresKeys<intent, options>
    ? z.output<UnwrapOptional<Intent.ShapeOf<intent>[K]>>
    : z.output<Intent.ShapeOf<intent>[K]>
} & MethodDetailsOutput<intent, options>

/** @internal */
type MergedRequestSchema<
  intent extends Intent.Intent,
  options extends fromIntent.Options<intent>,
> = z.ZodMiniType<
  OutputRequestType<intent, options>,
  z.input<z.ZodMiniObject<InputRequestShape<intent, options>>>
>

/**
 * A client-side configured method intent with credential creation logic.
 */
export type Client<
  intent extends AnyMethodIntent = MethodIntent,
  context extends z.ZodMiniType | undefined = z.ZodMiniType | undefined,
> = intent & {
  context?: context
  createCredential: CreateCredentialFn<
    intent,
    context extends z.ZodMiniType ? z.output<context> : Record<never, never>
  >
}
export type AnyClient = Client<any, any>

/**
 * A server-side configured method intent with verification logic.
 */
export type Server<
  intent extends AnyMethodIntent = MethodIntent,
  defaults extends ExactPartial<z.input<intent['schema']['request']>> = {},
  transportOverride = undefined,
> = intent & {
  defaults?: defaults | undefined
  request?: RequestFn<intent> | undefined
  respond?: RespondFn<intent> | undefined
  transport?: transportOverride | undefined
  verify: VerifyFn<intent>
}
export type AnyServer = Server<any, any, any>

/** Credential creation function for a single intent. */
export type CreateCredentialFn<intent extends AnyMethodIntent, context = unknown> = (
  parameters: {
    challenge: Challenge.Challenge<
      z.output<intent['schema']['request']>,
      intent['name'],
      intent['method']
    >
  } & ([keyof context] extends [never] ? unknown : { context: context }),
) => Promise<string>

/** Request transform function for a single intent. */
export type RequestFn<intent extends AnyMethodIntent> = (options: {
  credential?: Credential.Credential | null | undefined
  request: z.input<intent['schema']['request']>
}) => MaybePromise<z.input<intent['schema']['request']>>

/** Verification function for a single intent. */
export type VerifyFn<intent extends AnyMethodIntent> = (parameters: {
  credential: Credential.Credential<
    z.output<intent['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<intent['schema']['request']>, intent['name'], intent['method']>
  >
  request: z.input<intent['schema']['request']>
}) => Promise<Receipt.Receipt>

/**
 * Optional respond function for a server-side method intent.
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
export type RespondFn<intent extends AnyMethodIntent> = (parameters: {
  credential: Credential.Credential<
    z.output<intent['schema']['credential']['payload']>,
    Challenge.Challenge<z.output<intent['schema']['request']>, intent['name'], intent['method']>
  >
  input: globalThis.Request
  receipt: Receipt.Receipt
  request: z.input<intent['schema']['request']>
}) => MaybePromise<globalThis.Response | undefined>

/** Partial request type for defaults. */
export type RequestDefaults<intent extends AnyMethodIntent> = ExactPartial<
  z.input<intent['schema']['request']>
>

/** Makes fields optional if they exist in defaults. */
export type WithDefaults<request, defaults> = [keyof defaults] extends [never]
  ? request
  : LooseOmit<request, keyof defaults & string> &
      ExactPartial<Pick<request, keyof defaults & keyof request>>

/**
 * Extends a method intent with client-side credential creation logic.
 *
 * @example
 * ```ts
 * import { MethodIntent } from 'mpay'
 * import { Intents } from 'mpay/tempo'
 *
 * const tempoCharge = MethodIntent.toClient(Intents.charge, {
 *   async createCredential({ challenge }) {
 *     return Credential.serialize({ challenge, payload: { ... } })
 *   },
 * })
 * ```
 */
export function toClient<
  const intent extends AnyMethodIntent,
  const context extends z.ZodMiniType | undefined = undefined,
>(intent: intent, options: toClient.Options<intent, context>): Client<intent, context> {
  const { context, createCredential } = options
  return {
    ...intent,
    context,
    createCredential,
  } as Client<intent, context>
}

export declare namespace toClient {
  type Options<
    intent extends AnyMethodIntent,
    context extends z.ZodMiniType | undefined = undefined,
  > = {
    context?: context
    createCredential: CreateCredentialFn<
      intent,
      context extends z.ZodMiniType ? z.output<context> : Record<never, never>
    >
  }
}

/**
 * Extends a method intent with server-side verification logic.
 *
 * @example
 * ```ts
 * import { MethodIntent } from 'mpay'
 * import { Intents } from 'mpay/tempo'
 *
 * const tempoCharge = MethodIntent.toServer(Intents.charge, {
 *   async verify({ credential }) {
 *     // verification logic
 *     return { status: 'success', ... }
 *   },
 * })
 * ```
 */
export function toServer<
  const intent extends AnyMethodIntent,
  const defaults extends RequestDefaults<intent> = {},
  const transportOverride extends Transport.AnyTransport | undefined = undefined,
>(
  intent: intent,
  options: toServer.Options<intent, defaults, transportOverride>,
): Server<intent, defaults, transportOverride> {
  const { defaults, request, respond, transport, verify } = options
  return {
    ...intent,
    defaults,
    request,
    respond,
    transport,
    verify,
  } as Server<intent, defaults, transportOverride>
}

export declare namespace toServer {
  type Options<
    intent extends AnyMethodIntent,
    defaults extends RequestDefaults<intent> = {},
    transportOverride extends Transport.AnyTransport | undefined = undefined,
  > = {
    defaults?: defaults | undefined
    request?: RequestFn<intent> | undefined
    respond?: RespondFn<intent> | undefined
    transport?: transportOverride | undefined
    verify: VerifyFn<intent>
  }
}
