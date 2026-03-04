import type * as Challenge from '../Challenge.js'
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
  /** Methods to configure. */
  methods: FlattenMethods<methods>
  /** The transport used. */
  transport: transport
  /** Creates a credential from a payment-required response by routing to the correct method. */
  createCredential: (
    response: Transport.ResponseOf<transport>,
    context?: AnyContextFor<FlattenMethods<methods>> | undefined,
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
  const { onChallenge, polyfill = true, transport = Transport.http() as transport } = config

  const methods = config.methods.flat() as unknown as FlattenMethods<methods>

  const resolvedOnChallenge = onChallenge as Fetch.from.Config<
    FlattenMethods<methods>
  >['onChallenge']
  const config_fetch = {
    ...(config.fetch && { fetch: config.fetch }),
    ...(resolvedOnChallenge && { onChallenge: resolvedOnChallenge }),
    methods,
  } satisfies Fetch.from.Config<FlattenMethods<methods>>
  const fetch = Fetch.from<FlattenMethods<methods>>(config_fetch)

  if (polyfill) Fetch.polyfill(config_fetch)
  return {
    fetch,
    methods,
    transport,
    async createCredential(response: Transport.ResponseOf<transport>, context?: unknown) {
      const challenge = transport.getChallenge(response as never) as Challenge.Challenge

      const mi = methods.find((m) => m.name === challenge.method && m.intent === challenge.intent)
      if (!mi)
        throw new Error(
          `No method found for "${challenge.method}.${challenge.intent}". Available: ${methods.map((m) => `${m.name}.${m.intent}`).join(', ')}`,
        )

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
