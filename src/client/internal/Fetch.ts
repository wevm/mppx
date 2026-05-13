import { Emitter, TypedEvent } from 'rettime'

import * as Challenge from '../../Challenge.js'
import * as Expires from '../../Expires.js'
import * as AcceptPayment from '../../internal/AcceptPayment.js'
import type { MaybePromise } from '../../internal/types.js'
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

export type ClientEvents<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = Partial<{
  '*': ClientEventHandler<methods, '*'>
  'challenge.received': ClientEventHandler<methods, 'challenge.received'>
  'credential.created': ClientEventHandler<methods, 'credential.created'>
  'payment.failed': ClientEventHandler<methods, 'payment.failed'>
  'payment.response': ClientEventHandler<methods, 'payment.response'>
}>

export type ClientEventMap<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = {
  'challenge.received': ChallengeReceivedPayload<methods>
  'credential.created': CredentialCreatedPayload<methods>
  'payment.failed': PaymentFailedPayload<methods>
  'payment.response': PaymentResponsePayload<methods>
}

export type ClientEventName<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = keyof ClientEventMap<methods> | '*'

export type ClientEventEnvelope<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = {
  [name in keyof ClientEventMap<methods>]: Readonly<{
    name: name
    payload: ClientEventMap<methods>[name]
  }>
}[keyof ClientEventMap<methods>]

export type ClientEventPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  name extends ClientEventName<methods> = ClientEventName<methods>,
> = name extends '*'
  ? ClientEventEnvelope<methods>
  : name extends keyof ClientEventMap<methods>
    ? ClientEventMap<methods>[name]
    : never

export type ClientEventResult<
  methods extends readonly Method.AnyClient[],
  name extends ClientEventName<methods>,
> = name extends 'challenge.received' ? string | undefined : void

export type ClientEventHandler<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  name extends ClientEventName<methods> = ClientEventName<methods>,
> = (payload: ClientEventPayload<methods, name>) => MaybePromise<ClientEventResult<methods, name>>

export type Unsubscribe = () => void

export type ChallengeReceivedPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = Readonly<{
  challenge: Challenge.Challenge
  challenges: readonly Challenge.Challenge[]
  createCredential: (context?: AnyContextFor<methods>) => Promise<string>
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response: Response
}>

export type CredentialCreatedPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = Readonly<{
  challenge: Challenge.Challenge
  credential: string
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response?: Response | undefined
}>

export type PaymentResponsePayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = Readonly<{
  challenge: Challenge.Challenge
  credential: string
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response: Response
}>

export type PaymentFailedPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = Readonly<{
  challenge?: Challenge.Challenge | undefined
  challenges?: readonly Challenge.Challenge[] | undefined
  error: unknown
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method?: methods[number] | undefined
  response?: Response | undefined
}>

export type ClientEventDispatcher<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
> = {
  emit<name extends Exclude<ClientEventName<methods>, '*'>>(
    name: name,
    payload: ClientEventMap<methods>[name],
  ): Promise<ClientEventResult<methods, name>>
  on<name extends ClientEventName<methods>>(
    name: name,
    handler: ClientEventHandler<methods, name>,
  ): Unsubscribe
}

type ClientRettimeEventMap<methods extends readonly Method.AnyClient[]> = {
  'challenge.received': TypedEvent<
    ChallengeReceivedPayload<methods>,
    MaybePromise<string | undefined>
  >
  'credential.created': TypedEvent<CredentialCreatedPayload<methods>, MaybePromise<void>>
  'payment.failed': TypedEvent<PaymentFailedPayload<methods>, MaybePromise<void>>
  'payment.response': TypedEvent<PaymentResponsePayload<methods>, MaybePromise<void>>
}

type ClientWildcardEventMap<methods extends readonly Method.AnyClient[]> = {
  event: TypedEvent<ClientEventEnvelope<methods>, MaybePromise<void>>
}

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
  const events = config.eventDispatcher ?? createEventDispatcher(config.events)
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

    let challenge: Challenge.Challenge | undefined
    let challenges: readonly Challenge.Challenge[] | undefined
    let mi: methods[number] | undefined

    try {
      // Parse all challenges from the response (supports merged WWW-Authenticate headers).
      challenges = Challenge.fromResponseList(response)

      const selected = AcceptPayment.selectChallenge(
        challenges,
        methods,
        paymentPreferences.entries,
      )
      if (!selected)
        throw new Error(
          `No method found for challenges: ${challenges.map((c) => `${c.method}.${c.intent}`).join(', ')}. Available: ${methods.map((m) => `${m.name}.${m.intent}`).join(', ')}`,
        )

      challenge = selected.challenge
      mi = selected.method
      if (challenge.expires) Expires.assert(challenge.expires, challenge.id)

      const createCredential = async (overrideContext?: AnyContextFor<methods>) =>
        resolveCredential(challenge!, mi!, overrideContext ?? context)
      const eventCredential = await events.emit(
        'challenge.received',
        Object.freeze({
          challenge,
          challenges,
          createCredential,
          init,
          input,
          method: mi,
          response,
        }),
      )
      const onChallengeCredential =
        eventCredential ??
        (onChallenge
          ? await onChallenge(challenge, {
              createCredential,
            })
          : undefined)
      const credential = onChallengeCredential ?? (await createCredential())
      validateCredentialHeaderValue(credential)
      await events.emit(
        'credential.created',
        Object.freeze({
          challenge,
          credential,
          init,
          input,
          method: mi,
          response,
        }),
      )

      const paymentResponse = await baseFetch(initialRequest.input, {
        ...fetchInit,
        headers: withAuthorizationHeader(initialRequest.headers, credential),
      })
      await events.emit(
        'payment.response',
        Object.freeze({
          challenge,
          credential,
          init,
          input,
          method: mi,
          response: paymentResponse,
        }),
      )
      return paymentResponse
    } catch (error) {
      await events.emit(
        'payment.failed',
        Object.freeze({
          challenge,
          challenges,
          error,
          init,
          input,
          method: mi,
          response,
        }),
      )
      throw error
    }
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
    /** Client payment events for logging, analytics, and credential interception. */
    events?: ClientEvents<methods> | undefined
    /** Shared event dispatcher. Used by higher-level client handlers. */
    eventDispatcher?: ClientEventDispatcher<methods> | undefined
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

/** Creates a typed client payment event dispatcher. */
export function createEventDispatcher<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
>(initialEvents?: ClientEvents<methods> | undefined): ClientEventDispatcher<methods> {
  const emitter = new Emitter<ClientRettimeEventMap<methods>>()
  const wildcardEmitter = new Emitter<ClientWildcardEventMap<methods>>()

  const on: ClientEventDispatcher<methods>['on'] = (name, handler) => {
    switch (name) {
      case '*':
        return addRettimeListener(wildcardEmitter, 'event', (event) => handler(event.data as never))
      case 'challenge.received':
        return addRettimeListener(emitter, 'challenge.received', (event) =>
          handler(event.data as never),
        )
      case 'credential.created':
        return addRettimeListener(emitter, 'credential.created', (event) =>
          handler(event.data as never),
        )
      case 'payment.failed':
        return addRettimeListener(emitter, 'payment.failed', (event) =>
          handler(event.data as never),
        )
      case 'payment.response':
        return addRettimeListener(emitter, 'payment.response', (event) =>
          handler(event.data as never),
        )
    }
  }

  if (initialEvents?.['*']) on('*', initialEvents['*'])
  if (initialEvents?.['challenge.received'])
    on('challenge.received', initialEvents['challenge.received'])
  if (initialEvents?.['credential.created'])
    on('credential.created', initialEvents['credential.created'])
  if (initialEvents?.['payment.failed']) on('payment.failed', initialEvents['payment.failed'])
  if (initialEvents?.['payment.response']) on('payment.response', initialEvents['payment.response'])

  return {
    async emit(name, payload) {
      switch (name) {
        case 'challenge.received': {
          let credential: string | undefined
          const event = createRettimeEvent(name, payload)
          for (const result of emitter.emitAsGenerator(event)) {
            const value = await result
            if (value !== undefined) {
              credential = value
              break
            }
          }
          await emitCatchall(wildcardEmitter, name, payload)
          return credential as ClientEventResult<methods, typeof name>
        }
        case 'credential.created':
          await emitObserve(() => emitter.emitAsPromise(createRettimeEvent(name, payload)))
          await emitCatchall(wildcardEmitter, name, payload)
          return undefined as ClientEventResult<methods, typeof name>
        case 'payment.failed':
          await emitObserve(() => emitter.emitAsPromise(createRettimeEvent(name, payload)))
          await emitCatchall(wildcardEmitter, name, payload)
          return undefined as ClientEventResult<methods, typeof name>
        case 'payment.response':
          await emitObserve(() => emitter.emitAsPromise(createRettimeEvent(name, payload)))
          await emitCatchall(wildcardEmitter, name, payload)
          return undefined as ClientEventResult<methods, typeof name>
      }
    },
    on,
  }
}

function addRettimeListener(
  emitter: Emitter<any>,
  name: string,
  handler: (event: TypedEvent<any, any>) => unknown,
): Unsubscribe {
  const controller = new AbortController()
  emitter.on(name, handler as never, { signal: controller.signal })
  return () => controller.abort()
}

function createRettimeEvent(name: string, payload: unknown): never {
  return new TypedEvent<unknown, unknown, string>(name, { data: payload }) as never
}

async function emitCatchall<
  methods extends readonly Method.AnyClient[],
  name extends keyof ClientEventMap<methods>,
>(
  emitter: Emitter<ClientWildcardEventMap<methods>>,
  name: name,
  payload: ClientEventMap<methods>[name],
) {
  const event = Object.freeze({ name, payload }) as ClientEventPayload<methods, '*'>
  await emitObserve(() => emitter.emitAsPromise(createRettimeEvent('event', event)))
}

async function emitObserve(emit: () => MaybePromise<unknown>): Promise<void> {
  try {
    await emit()
  } catch {
    // Client observation events must not alter payment flow.
  }
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
