import type * as Challenge from '../Challenge.js'
import * as AcceptPayment from '../internal/AcceptPayment.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import * as Fetch from './internal/Fetch.js'
import * as Transport from './Transport.js'

export type Methods = readonly (Method.AnyClient | readonly Method.AnyClient[])[]

/**
 * Client-side payment handler.
 */
export type Mppx<
  methods extends Methods = Methods,
  transport extends Transport.Transport = Transport.Transport,
> = {
  /** Payment-aware fetch function that automatically handles 402 responses. */
  fetch: Fetch.from.Fetch<FlattenMethods<methods>>
  /** The original, unwrapped fetch function (pre-polyfill). Useful when you need to make requests that should not be intercepted (e.g. 402 probes for websocket auth). */
  rawFetch: typeof globalThis.fetch
  /** Methods to configure. */
  methods: FlattenMethods<methods>
  /** The transport used. */
  transport: transport
  /** Creates a credential from a payment-required response by routing to the correct method. */
  createCredential: (
    response: Transport.ResponseOf<transport>,
    context?: AnyContextFor<FlattenMethods<methods>> | undefined,
    options?: createCredential.Options | undefined,
  ) => Promise<string>
}

/**
 * Creates a client-side payment handler from an array of methods.
 *
 * Returns a payment handler with a `fetch` function that automatically handles
 * 402 Payment Required responses. By default, also polyfills `globalThis.fetch`.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo({ account })],
 * })
 *
 * // Use the returned fetch — handles 402 automatically
 * const res = await mppx.fetch('/resource')
 *
 * // Or use globalThis.fetch (polyfilled by default)
 * const res2 = await fetch('/resource')
 * ```
 */
export function create<
  const methods extends Methods,
  const transport extends Transport.Transport<any, any> = Transport.Transport<
    RequestInit,
    Response
  >,
>(config: create.Config<methods, transport>): Mppx<methods, transport> {
  const {
    onChallenge,
    polyfill = true,
    acceptPaymentPolicy = polyfill ? 'same-origin' : 'always',
    transport = Transport.http() as transport,
  } = config

  const rawFetch = config.fetch ?? globalThis.fetch
  const methods = config.methods.flat() as unknown as FlattenMethods<methods>
  const acceptPayment = AcceptPayment.resolve(methods, config.paymentPreferences)

  const resolvedOnChallenge = onChallenge as Fetch.from.Config<
    FlattenMethods<methods>
  >['onChallenge']
  const config_fetch = {
    acceptPayment,
    acceptPaymentPolicy,
    ...(config.fetch && { fetch: config.fetch }),
    ...(resolvedOnChallenge && { onChallenge: resolvedOnChallenge }),
    methods,
  } satisfies Fetch.from.Config<FlattenMethods<methods>>
  const fetch = Fetch.from<FlattenMethods<methods>>(config_fetch)

  if (polyfill) Fetch.polyfill(config_fetch)
  return {
    fetch,
    rawFetch,
    methods,
    transport,
    async createCredential(
      response: Transport.ResponseOf<transport>,
      context?: unknown,
      options?: createCredential.Options,
    ) {
      const challenges = transport.getChallenges
        ? transport.getChallenges(response as never)
        : [transport.getChallenge(response as never)]
      const preferences = resolveChallengePreferences(acceptPayment.entries, options?.acceptPayment)

      const selected = AcceptPayment.selectChallenge(challenges, methods, preferences)
      if (!selected)
        throw new Error(
          `No method found for challenges: ${challenges.map((challenge) => `${challenge.method}.${challenge.intent}`).join(', ')}. Available: ${methods.map((m) => `${m.name}.${m.intent}`).join(', ')}`,
        )

      const { challenge, method: mi } = selected

      const parsedContext =
        mi.context && context !== undefined ? mi.context.parse(context) : undefined

      return mi.createCredential(
        parsedContext !== undefined
          ? { challenge, context: parsedContext }
          : ({ challenge } as never),
      )
    },
  }
}

export declare namespace createCredential {
  type Options = {
    /** Request-local Accept-Payment override for manual rawFetch + createCredential flows. */
    acceptPayment?: string | readonly AcceptPayment.Entry[] | undefined
  }
}

/**
 * Restores the original `fetch` after `create()` polyfilled it.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/client'
 *
 * Mppx.create({ methods: [tempo({ account })] })
 *
 * // ... use payment-aware fetch ...
 *
 * Mppx.restore()
 * ```
 */
export function restore(): void {
  Fetch.restore()
}

export declare namespace create {
  type Config<
    methods extends Methods = Methods,
    transport extends Transport.Transport = Transport.Transport,
  > = {
    /** Controls when `Accept-Payment` is injected. */
    acceptPaymentPolicy?: Fetch.from.Config['acceptPaymentPolicy'] | undefined
    /** Custom fetch function to wrap. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch
    /** Called when a 402 challenge is received, before credential creation. */
    onChallenge?:
      | ((
          challenge: Challenge.Challenge,
          helpers: {
            createCredential: (context?: AnyContextFor<FlattenMethods<methods>>) => Promise<string>
          },
        ) => Promise<string | undefined>)
      | undefined
    /** Client-declared supported payment methods, keyed by typed `method/intent` strings. */
    paymentPreferences?: AcceptPayment.Config<FlattenMethods<methods>> | undefined
    /** Array of methods to use. Accepts individual clients or tuples (e.g. from `tempo()`). */
    methods: methods
    /** Whether to polyfill `globalThis.fetch` with the payment-aware wrapper. @default true */
    polyfill?: boolean | undefined
    /** Transport to use (defaults to HTTP). */
    transport?: transport | undefined
  }
}

/**
 * Union of all context types from all methods that have context schemas.
 * @internal
 */
type AnyContextFor<methods extends readonly Method.AnyClient[]> = {
  [method in keyof methods]: NonNullable<methods[method]['context']> extends infer ctx
    ? ctx extends z.ZodMiniType
      ? z.input<ctx>
      : undefined
    : undefined
}[number]

/**
 * Flattens a methods config tuple, preserving positional types.
 * @internal
 */
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

function resolveChallengePreferences(
  fallback: readonly AcceptPayment.Entry[],
  override?: string | readonly AcceptPayment.Entry[] | undefined,
): readonly AcceptPayment.Entry[] {
  if (!override) return fallback
  return typeof override === 'string' ? AcceptPayment.parse(override) : override
}
