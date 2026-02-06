import * as Challenge from '../Challenge.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'

type AnyClient = Method.Client<any, any, any>

let originalFetch: typeof globalThis.fetch | undefined

/**
 * Creates a fetch wrapper that automatically handles 402 Payment Required responses.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mpay/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const fetch = Fetch.from({
 *   methods: [
 *     tempo.charge({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 *
 * // Use the wrapped fetch — handles 402 automatically
 * const res = await fetch('https://api.example.com/resource')
 * ```
 */
export function from<const methods extends readonly Method.AnyClient[]>(
  config: from.Config<methods>,
): from.Fetch<methods> {
  const { fetch = globalThis.fetch, methods } = config

  return async (input, init) => {
    const context = init?.context
    const response = await fetch(input, init)

    if (response.status !== 402) return response

    const credential = await createCredential(response, { context, methods })

    return fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: credential,
      },
    })
  }
}

/** Union of all context types from all methods that have context schemas. */
type AnyContextFor<methods extends readonly Method.AnyClient[]> = {
  [K in keyof methods]: methods[K] extends Method.Client<any, any, infer contextSchema>
    ? contextSchema extends z.ZodMiniType
      ? z.input<contextSchema>
      : undefined
    : undefined
}[number]

export declare namespace from {
  type Config<methods extends readonly Method.AnyClient[] = readonly AnyClient[]> = {
    /** Custom fetch function to wrap. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch
    /** Array of payment methods to use. */
    methods: methods
  }

  type Fetch<methods extends readonly Method.AnyClient[] = readonly AnyClient[]> = (
    input: RequestInfo | URL,
    init?: RequestInit<methods>,
  ) => Promise<Response>

  type RequestInit<methods extends readonly Method.AnyClient[] = readonly AnyClient[]> =
    globalThis.RequestInit & {
      /** Context to pass to the payment method's createCredential. */
      context?: AnyContextFor<methods>
    }
}

/**
 * Replaces the global `fetch` with a payment-aware wrapper.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mpay/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * Fetch.polyfill({
 *   methods: [
 *     tempo.charge({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 *
 * // Global fetch now handles 402 automatically
 * const res = await fetch('https://api.example.com/resource')
 * ```
 */
export function polyfill<const methods extends readonly AnyClient[]>(
  config: polyfill.Config<methods>,
): void {
  originalFetch = globalThis.fetch
  globalThis.fetch = from(config) as typeof globalThis.fetch
}

export declare namespace polyfill {
  type Config<methods extends readonly Method.AnyClient[] = readonly AnyClient[]> = {
    /** Array of payment methods to use. */
    methods: methods
  }
}

/**
 * Restores the original `fetch` after calling `polyfill`.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mpay/client'
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
async function createCredential<methods extends readonly Method.AnyClient[]>(
  response: Response,
  config: {
    context?: unknown
    methods: methods
  },
): Promise<string> {
  const { context, methods } = config
  const challenge = Challenge.fromResponse(response)

  const method = methods.find((m) => m.name === challenge.method)
  if (!method)
    throw new Error(
      `No method found for "${challenge.method}". Available: ${methods.map((m) => m.name).join(', ')}`,
    )

  const parsedContext =
    method.context && context !== undefined ? method.context.parse(context) : undefined
  return method.createCredential(
    parsedContext !== undefined ? { challenge, context: parsedContext } : ({ challenge } as never),
  )
}
