import * as Challenge from '../../Challenge.js'
import * as Expires from '../../Expires.js'
import * as AcceptPayment from '../../internal/AcceptPayment.js'
import type * as Method from '../../Method.js'
import type * as z from '../../zod.js'

// We tag wrappers with a global symbol so we can recognize wrappers created by mppx,
// even across multiple module instances/bundles. This lets restore() avoid clobbering
// an unrelated fetch installed by user code or another library.
const MPPX_FETCH_WRAPPER = Symbol.for('mppx.fetch.wrapper')

type WrappedFetch = typeof globalThis.fetch & {
  [MPPX_FETCH_WRAPPER]?: typeof globalThis.fetch
}

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
export function from<const methods extends readonly Method.AnyClient[]>(
  config: from.Config<methods>,
): from.Fetch<methods> {
  const {
    acceptPayment,
    acceptPaymentPolicy = 'always',
    fetch = globalThis.fetch,
    methods,
    onChallenge,
  } = config
  const resolvedAcceptPayment = acceptPayment ?? AcceptPayment.resolve(methods)
  // Always operate on the true underlying fetch to avoid wrapper-on-wrapper stacking,
  // which can duplicate retries and make restore semantics fragile.
  const baseFetch = unwrapFetch(fetch)

  const wrappedFetch = async (input: RequestInfo | URL, init?: from.RequestInit<methods>) => {
    const callerHeaders = getCallerHeaders(input, init?.headers)
    const hasExplicitAcceptPayment = callerHeaders.has('Accept-Payment')
    const paymentPreferences = resolvePaymentPreferences(callerHeaders, resolvedAcceptPayment)
    const initialRequest = prepareInitialRequest(
      input,
      init,
      callerHeaders,
      paymentPreferences.header,
      hasExplicitAcceptPayment,
      acceptPaymentPolicy,
    )
    const response = await baseFetch(initialRequest.input, initialRequest.init)

    if (response.status !== 402) return response

    // Only extract context for payment handling after confirming 402.
    const context = (init as Record<string, unknown> | undefined)?.context
    const { context: _, ...fetchInit } = (initialRequest.init ?? {}) as Record<string, unknown>

    // Parse all challenges from the response (supports merged WWW-Authenticate headers).
    const challenges = Challenge.fromResponseList(response)

    const selected = AcceptPayment.selectChallenge(challenges, methods, paymentPreferences.entries)
    if (!selected)
      throw new Error(
        `No method found for challenges: ${challenges.map((c) => `${c.method}.${c.intent}`).join(', ')}. Available: ${methods.map((m) => `${m.name}.${m.intent}`).join(', ')}`,
      )

    const { challenge, method: mi } = selected
    if (challenge.expires) Expires.assert(challenge.expires, challenge.id)

    const onChallengeCredential = onChallenge
      ? await onChallenge(challenge, {
          createCredential: async (overrideContext?: AnyContextFor<methods>) =>
            resolveCredential(challenge, mi!, overrideContext ?? context),
        })
      : undefined
    const credential = onChallengeCredential ?? (await resolveCredential(challenge, mi, context))
    validateCredentialHeaderValue(credential)

    return baseFetch(initialRequest.input, {
      ...fetchInit,
      headers: withAuthorizationHeader(initialRequest.headers, credential),
    })
  }

  // Record the wrapped target so future polyfill() / restore() calls can detect origin
  // and safely unwrap only mppx-installed wrappers.
  ;(wrappedFetch as WrappedFetch)[MPPX_FETCH_WRAPPER] = baseFetch
  return wrappedFetch as from.Fetch<methods>
}

/** Union of all context types from all methods that have context schemas. */
type AnyContextFor<methods extends readonly Method.AnyClient[]> = {
  [K in keyof methods]: NonNullable<methods[K]['context']> extends infer ctx
    ? ctx extends z.ZodMiniType
      ? z.input<ctx>
      : undefined
    : undefined
}[number]

export declare namespace from {
  type Config<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> = {
    /** Resolved `Accept-Payment` header and selection preferences. */
    acceptPayment?: AcceptPayment.Resolved<methods> | undefined
    /** Controls when `Accept-Payment` is injected. @default 'always' */
    acceptPaymentPolicy?:
      | 'always'
      | 'same-origin'
      | 'never'
      | { origins: readonly string[] }
      | undefined
    /** Custom fetch function to wrap. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch
    /** Array of methods to use. */
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

  type Fetch<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> = (
    input: RequestInfo | URL,
    init?: RequestInit<methods>,
  ) => Promise<Response>

  type RequestInit<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> =
    globalThis.RequestInit & {
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
export function polyfill<const methods extends readonly Method.AnyClient[]>(
  config: polyfill.Config<methods>,
): void {
  // Defensive guard for runtimes/tests where fetch might be non-configurable.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  if (!descriptor || (!descriptor.writable && !descriptor.set)) {
    throw new Error('globalThis.fetch is not writable')
  }

  if (!originalFetch) originalFetch = globalThis.fetch
  globalThis.fetch = from({
    ...config,
    acceptPaymentPolicy: config.acceptPaymentPolicy ?? (isBrowser() ? 'same-origin' : 'always'),
    fetch: globalThis.fetch,
  }) as typeof globalThis.fetch
}

export declare namespace polyfill {
  type Config<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> =
    from.Config<methods>
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
  // Only restore if the current fetch is still an mppx wrapper.
  // If app code replaced fetch after polyfill(), we must not overwrite it.
  if (originalFetch && isWrappedFetch(globalThis.fetch)) {
    globalThis.fetch = originalFetch
    originalFetch = undefined
  }
}

/** @internal Normalizes headers to a plain object for spreading. */
export function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers as Record<string, string>
}

/** @internal */
function withAuthorizationHeader(headers: unknown, credential: string): Record<string, string> {
  const normalized = normalizeHeaders(headers)
  // Remove any existing Authorization header regardless of casing to avoid
  // duplicate/conflicting credentials on retry.
  for (const key of Object.keys(normalized)) {
    if (key.toLowerCase() === 'authorization') delete normalized[key]
  }
  normalized.Authorization = credential
  return normalized
}

/** @internal */
function prepareInitialRequest<methods extends readonly Method.AnyClient[]>(
  input: RequestInfo | URL,
  init: from.RequestInit<methods> | undefined,
  callerHeaders: Headers,
  header: string,
  hasExplicitAcceptPayment: boolean,
  policy: NonNullable<from.Config['acceptPaymentPolicy']>,
): { headers: Headers; init: from.RequestInit<methods> | undefined; input: RequestInfo | URL } {
  const shouldInjectAcceptPayment =
    Boolean(header) && !hasExplicitAcceptPayment && shouldInjectForPolicy(input, policy)
  if (!shouldInjectAcceptPayment) return { headers: callerHeaders, init, input }

  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  callerHeaders.forEach((value, key) => {
    headers.set(key, value)
  })
  headers.set('Accept-Payment', header)

  if (init) {
    // Preserve init identity for callers like websocket upgrade helpers that
    // depend on the original RequestInit object reaching the underlying fetch.
    ;(init as from.RequestInit<methods> & { headers?: HeadersInit }).headers = headers
    return {
      headers,
      init,
      input,
    }
  }

  return {
    headers,
    init: shouldInjectAcceptPayment ? ({ headers } as from.RequestInit<methods>) : undefined,
    input,
  }
}

/** @internal */
function getCallerHeaders(input: RequestInfo | URL, headers: HeadersInit | undefined): Headers {
  if (headers) return new Headers(headers)
  return new Headers(input instanceof Request ? input.headers : undefined)
}

/** @internal */
function unwrapFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  let current = fetch as WrappedFetch
  while (current[MPPX_FETCH_WRAPPER]) {
    current = current[MPPX_FETCH_WRAPPER] as WrappedFetch
  }
  return current as typeof globalThis.fetch
}

/** @internal */
function isWrappedFetch(fetch: typeof globalThis.fetch): fetch is WrappedFetch {
  return Boolean((fetch as WrappedFetch)[MPPX_FETCH_WRAPPER])
}

/** @internal */
function validateCredentialHeaderValue(credential: string): void {
  if (!credential.trim()) throw new Error('Credential header value must be non-empty')
  if (credential.includes('\r') || credential.includes('\n')) {
    throw new Error('Credential header value contains illegal newline characters')
  }
}

/** @internal */
async function resolveCredential(
  challenge: Challenge.Challenge,
  mi: Method.AnyClient,
  context: unknown,
): Promise<string> {
  const parsedContext = mi.context && context !== undefined ? mi.context.parse(context) : undefined
  return mi.createCredential(
    parsedContext !== undefined ? { challenge, context: parsedContext } : ({ challenge } as never),
  )
}

function resolvePaymentPreferences<methods extends readonly Method.AnyClient[]>(
  headers: Headers,
  acceptPayment: AcceptPayment.Resolved<methods>,
): AcceptPayment.Resolved<methods> {
  const header = headers.get('Accept-Payment')
  if (!header) return acceptPayment

  try {
    return {
      ...acceptPayment,
      entries: AcceptPayment.parse(header),
      header,
    }
  } catch {
    // Fail open for explicit malformed headers: preserve the caller's header on
    // the wire, but continue automatic challenge selection with configured
    // defaults instead of throwing from the wrapper.
    return acceptPayment
  }
}

/** @internal */
function shouldInjectForPolicy(
  input: RequestInfo | URL,
  policy: NonNullable<from.Config['acceptPaymentPolicy']>,
): boolean {
  if (policy === 'always') return true
  if (policy === 'never') return false

  const url = resolveRequestUrl(input)

  if (policy === 'same-origin') {
    if (!isBrowser()) return true
    return url.origin === globalThis.location.origin
  }

  return policy.origins.some((origin) => matchesOrigin(url, origin))
}

/** @internal Matches an origin pattern, supporting `*.` prefix for subdomain wildcards. */
function matchesOrigin(url: URL, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // e.g. ".example.com"
    return url.hostname.endsWith(suffix) || url.hostname === pattern.slice(2)
  }
  return url.origin === new URL(pattern).origin
}

/** @internal */
function isBrowser(): boolean {
  return typeof globalThis.location !== 'undefined'
}

/** @internal */
function resolveRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  return new URL(input, isBrowser() ? globalThis.location.href : undefined)
}
