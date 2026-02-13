import * as Challenge from '../../Challenge.js'
import type * as MethodIntent from '../../MethodIntent.js'
import type * as z from '../../zod.js'

let originalFetch: typeof globalThis.fetch | undefined

/**
 * Creates a fetch wrapper that automatically handles 402 Payment Required responses.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const fetch = Fetch.from({
 *   methods: [
 *     tempo({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 *
 * // Use the wrapped fetch — handles 402 automatically
 * const res = await fetch('https://api.example.com/resource')
 * ```
 *
 */
export function from<const methods extends readonly MethodIntent.AnyClient[]>(
  config: from.Config<methods>,
): from.Fetch<methods> {
  const { fetch = globalThis.fetch, methods, onChallenge } = config

  return async (input, init) => {
    const { context, ...fetchInit } = init ?? {}
    const response = await fetch(input, fetchInit)

    if (response.status !== 402) return response

    const challenge = Challenge.fromResponse(response)

    const mi = methods.find((m) => m.method === challenge.method && m.name === challenge.intent)
    if (!mi)
      throw new Error(
        `No method intent found for "${challenge.method}.${challenge.intent}". Available: ${methods.map((m) => `${m.method}.${m.name}`).join(', ')}`,
      )

    const onChallengeCredential = onChallenge
      ? await onChallenge(challenge, {
          createCredential: async (overrideContext?: AnyContextFor<methods>) =>
            resolveCredential(challenge, mi, overrideContext ?? context),
        })
      : undefined
    const credential = onChallengeCredential ?? (await resolveCredential(challenge, mi, context))

    return fetch(input, {
      ...fetchInit,
      headers: {
        ...fetchInit.headers,
        Authorization: credential,
      },
    })
  }
}

/** Union of all context types from all methods that have context schemas. */
type AnyContextFor<methods extends readonly MethodIntent.AnyClient[]> = {
  [K in keyof methods]: methods[K] extends MethodIntent.Client<any, infer contextSchema>
    ? contextSchema extends z.ZodMiniType
      ? z.input<contextSchema>
      : undefined
    : undefined
}[number]

export declare namespace from {
  type Config<
    methods extends readonly MethodIntent.AnyClient[] = readonly MethodIntent.AnyClient[],
  > = {
    /** Custom fetch function to wrap. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch
    /** Array of method intents to use. */
    methods: methods
    /** Called when a 402 challenge is received, before credential creation. */
    onChallenge?:
      | ((
          challenge: Challenge.Challenge,
          helpers: {
            createCredential: (context?: AnyContextFor<methods>) => Promise<string>
          },
        ) => Promise<string | undefined>)
      | undefined
  }

  type Fetch<
    methods extends readonly MethodIntent.AnyClient[] = readonly MethodIntent.AnyClient[],
  > = (input: RequestInfo | URL, init?: RequestInit<methods>) => Promise<Response>

  type RequestInit<
    methods extends readonly MethodIntent.AnyClient[] = readonly MethodIntent.AnyClient[],
  > = globalThis.RequestInit & {
    /** Context to pass to the method intent's createCredential. */
    context?: AnyContextFor<methods>
  }
}

/**
 * Replaces the global `fetch` with a payment-aware wrapper.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * Fetch.polyfill({
 *   methods: [
 *     tempo({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 *
 * // Global fetch now handles 402 automatically
 * const res = await fetch('https://api.example.com/resource')
 * ```
 */
export function polyfill<const methods extends readonly MethodIntent.AnyClient[]>(
  config: polyfill.Config<methods>,
): void {
  originalFetch = globalThis.fetch
  globalThis.fetch = from(config) as typeof globalThis.fetch
}

export declare namespace polyfill {
  type Config<
    methods extends readonly MethodIntent.AnyClient[] = readonly MethodIntent.AnyClient[],
  > = from.Config<methods>
}

/**
 * Restores the original `fetch` after calling `polyfill`.
 *
 * @example
 * ```ts
 * import { Fetch } from 'mppx/client'
 *
 * Fetch.polyfill({ methods: [...] })
 *
 * // ... use payment-aware fetch ...
 *
 * Fetch.restore()
 * ```
 */
export function restore(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = undefined
  }
}

/** @internal */
async function resolveCredential(
  challenge: Challenge.Challenge,
  mi: MethodIntent.AnyClient,
  context: unknown,
): Promise<string> {
  const parsedContext = mi.context && context !== undefined ? mi.context.parse(context) : undefined
  return mi.createCredential(
    parsedContext !== undefined ? { challenge, context: parsedContext } : ({ challenge } as never),
  )
}
