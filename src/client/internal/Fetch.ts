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

export type ClientEventMap<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = {
  'challenge.received': ChallengeReceivedPayload<methods, response>
  'credential.created': CredentialCreatedPayload<methods, response>
  'payment.failed': PaymentFailedPayload<methods, response>
  'payment.response': PaymentResponsePayload<methods, response>
}

export type ClientEventName<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = keyof ClientEventMap<methods, response> | '*'

export type ClientEventEnvelope<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = {
  [name in keyof ClientEventMap<methods, response>]: Readonly<{
    name: name
    payload: ClientEventMap<methods, response>[name]
  }>
}[keyof ClientEventMap<methods, response>]

export type ClientEventPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  name extends ClientEventName<methods> = ClientEventName<methods>,
  response = Response,
> = name extends '*'
  ? ClientEventEnvelope<methods, response>
  : name extends keyof ClientEventMap<methods, response>
    ? ClientEventMap<methods, response>[name]
    : never

export type ClientEventResult<
  methods extends readonly Method.AnyClient[],
  name extends ClientEventName<methods> = ClientEventName<methods>,
  _response = Response,
> = name extends 'challenge.received' ? string | undefined : void

export type ClientEventHandler<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  name extends ClientEventName<methods> = ClientEventName<methods>,
  response = Response,
> = (
  payload: ClientEventPayload<methods, name, response>,
) => MaybePromise<ClientEventResult<methods, name, response>>

export type Unsubscribe = () => void

export type ChallengeReceivedPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = Readonly<{
  challenge: Challenge.Challenge
  challenges: readonly Challenge.Challenge[]
  createCredential: (context?: AnyContextFor<methods>) => Promise<string>
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response: response
}>

export type CredentialCreatedPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = Readonly<{
  challenge: Challenge.Challenge
  credential: string
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response?: response | undefined
}>

export type PaymentResponsePayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = Readonly<{
  challenge: Challenge.Challenge
  credential: string
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response: response
}>

export type PaymentFailedPayload<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = Readonly<{
  challenge?: Challenge.Challenge | undefined
  challenges?: readonly Challenge.Challenge[] | undefined
  error: unknown
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method?: methods[number] | undefined
  response?: response | undefined
}>

export type ClientEventDispatcher<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
> = {
  emit<name extends Exclude<ClientEventName<methods, response>, '*'>>(
    name: name,
    payload: ClientEventMap<methods, response>[name],
  ): Promise<ClientEventResult<methods, name, response>>
  on<name extends ClientEventName<methods, response>>(
    name: name,
    handler: ClientEventHandler<methods, name, response>,
  ): Unsubscribe
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
  const events = config.eventDispatcher ?? createEventDispatcher()
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

      const selectedChallenge = selected.challenge
      challenge = selectedChallenge
      mi = selected.method
      if (challenge.expires) Expires.assert(challenge.expires, challenge.id)

      const createCredential = memoizeCreateCredential((overrideContext?: AnyContextFor<methods>) =>
        resolveCredential(selectedChallenge, selected.method, overrideContext ?? context),
      )
      const eventCredential = await events.emit(
        'challenge.received',
        createChallengeReceivedPayload({
          challenge: selectedChallenge,
          challenges,
          createCredential,
          init,
          input,
          method: selected.method,
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
        createCredentialCreatedPayload({
          challenge: selectedChallenge,
          credential,
          init,
          input,
          method: selected.method,
          response,
        }),
      )

      const paymentResponse = await baseFetch(initialRequest.input, {
        ...fetchInit,
        headers: withAuthorizationHeader(initialRequest.headers, credential),
      })
      if (paymentResponse.ok)
        await events.emit(
          'payment.response',
          createPaymentResponsePayload({
            challenge: selectedChallenge,
            credential,
            init,
            input,
            method: selected.method,
            response: paymentResponse,
          }),
        )
      return paymentResponse
    } catch (error) {
      await events.emit(
        'payment.failed',
        createPaymentFailedPayload({
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
    /** Advanced shared event dispatcher. `challenge.received` handlers run before `onChallenge`; the first non-empty credential returned by a handler skips `onChallenge`. */
    eventDispatcher?: ClientEventDispatcher<methods, any> | undefined
    /** Array of methods to use. */
    methods: methods
    /** Called when a 402 challenge is received and no event handler supplies a credential. */
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

/**
 * Creates a typed client payment event dispatcher.
 *
 * `challenge.received` handlers run before `onChallenge`; the first non-empty
 * credential returned by a handler wins. Observation handlers are isolated, so
 * thrown listener errors do not stop sibling listeners or payment flow.
 */
export function createEventDispatcher<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  response = Response,
>(): ClientEventDispatcher<methods, response> {
  const handlers = {
    '*': new Set<ClientEventHandler<methods, '*', response>>(),
    'challenge.received': new Set<ClientEventHandler<methods, 'challenge.received', response>>(),
    'credential.created': new Set<ClientEventHandler<methods, 'credential.created', response>>(),
    'payment.failed': new Set<ClientEventHandler<methods, 'payment.failed', response>>(),
    'payment.response': new Set<ClientEventHandler<methods, 'payment.response', response>>(),
  }

  const on: ClientEventDispatcher<methods, response>['on'] = (name, handler) => {
    switch (name) {
      case '*':
      case 'challenge.received':
      case 'credential.created':
      case 'payment.failed':
      case 'payment.response':
        handlers[name].add(handler as never)
        return () => handlers[name].delete(handler as never)
      default:
        throw new Error(`Unknown client event "${String(name)}".`)
    }
  }

  return {
    async emit(name, payload) {
      switch (name) {
        case 'challenge.received': {
          let credential: string | undefined
          for (const handler of handlers['challenge.received']) {
            const value = await emitChallengeReceived(
              handler,
              payload as ChallengeReceivedPayload<methods, response>,
            )
            if (typeof value === 'string' && value.length > 0) {
              credential = value
              break
            }
          }
          await emitCatchall(handlers['*'], name, payload)
          return credential as ClientEventResult<methods, typeof name, response>
        }
        case 'credential.created':
          await emitObserveHandlers(handlers['credential.created'], payload)
          await emitCatchall(handlers['*'], name, payload)
          return undefined as ClientEventResult<methods, typeof name, response>
        case 'payment.failed':
          await emitObserveHandlers(handlers['payment.failed'], payload)
          await emitCatchall(handlers['*'], name, payload)
          return undefined as ClientEventResult<methods, typeof name, response>
        case 'payment.response':
          await emitObserveHandlers(handlers['payment.response'], payload)
          await emitCatchall(handlers['*'], name, payload)
          return undefined as ClientEventResult<methods, typeof name, response>
      }
    },
    on,
  }
}

async function emitChallengeReceived<methods extends readonly Method.AnyClient[], response>(
  handler: ClientEventHandler<methods, 'challenge.received', response>,
  payload: ChallengeReceivedPayload<methods, response>,
): Promise<string | undefined> {
  try {
    return await handler(payload)
  } catch {
    return undefined
  }
}

async function emitObserveHandlers(
  handlers: ReadonlySet<(payload: never) => MaybePromise<unknown>>,
  payload: unknown,
): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(payload as never)
    } catch {
      // Client observation events must not alter payment flow.
    }
  }
}

async function emitCatchall<
  methods extends readonly Method.AnyClient[],
  response,
  name extends keyof ClientEventMap<methods, response>,
>(
  handlers: ReadonlySet<ClientEventHandler<methods, '*', response>>,
  name: name,
  payload: ClientEventMap<methods, response>[name],
) {
  await emitObserveHandlers(
    handlers as ReadonlySet<(payload: never) => MaybePromise<unknown>>,
    Object.freeze({ name, payload }) as ClientEventPayload<methods, '*', response>,
  )
}

function memoizeCreateCredential<methods extends readonly Method.AnyClient[]>(
  createCredential: (context?: AnyContextFor<methods>) => Promise<string>,
) {
  let promise: Promise<string> | undefined
  return (context?: AnyContextFor<methods>) => {
    promise ??= createCredential(context)
    return promise
  }
}

function createChallengeReceivedPayload<
  methods extends readonly Method.AnyClient[],
  response,
>(parameters: {
  challenge: Challenge.Challenge
  challenges: readonly Challenge.Challenge[]
  createCredential: (context?: AnyContextFor<methods>) => Promise<string>
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response: response
}): ChallengeReceivedPayload<methods, response> {
  return Object.freeze({
    challenge: snapshotValue(parameters.challenge),
    challenges: parameters.challenges.map((challenge) => snapshotValue(challenge)),
    createCredential: parameters.createCredential,
    init: snapshotInit(parameters.init),
    input: snapshotInput(parameters.input),
    method: snapshotMethod(parameters.method),
    response: snapshotResponse(parameters.response),
  }) as never
}

function createCredentialCreatedPayload<
  methods extends readonly Method.AnyClient[],
  response,
>(parameters: {
  challenge: Challenge.Challenge
  credential: string
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response?: response | undefined
}): CredentialCreatedPayload<methods, response> {
  return Object.freeze({
    challenge: snapshotValue(parameters.challenge),
    credential: parameters.credential,
    init: snapshotInit(parameters.init),
    input: snapshotInput(parameters.input),
    method: snapshotMethod(parameters.method),
    ...(parameters.response !== undefined
      ? { response: snapshotResponse(parameters.response) }
      : {}),
  }) as never
}

function createPaymentResponsePayload<
  methods extends readonly Method.AnyClient[],
  response,
>(parameters: {
  challenge: Challenge.Challenge
  credential: string
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method: methods[number]
  response: response
}): PaymentResponsePayload<methods, response> {
  return Object.freeze({
    challenge: snapshotValue(parameters.challenge),
    credential: parameters.credential,
    init: snapshotInit(parameters.init),
    input: snapshotInput(parameters.input),
    method: snapshotMethod(parameters.method),
    response: snapshotResponse(parameters.response),
  }) as never
}

function createPaymentFailedPayload<
  methods extends readonly Method.AnyClient[],
  response,
>(parameters: {
  challenge?: Challenge.Challenge | undefined
  challenges?: readonly Challenge.Challenge[] | undefined
  error: unknown
  init?: from.RequestInit<methods> | undefined
  input?: RequestInfo | URL | undefined
  method?: methods[number] | undefined
  response?: response | undefined
}): PaymentFailedPayload<methods, response> {
  return Object.freeze({
    ...(parameters.challenge ? { challenge: snapshotValue(parameters.challenge) } : {}),
    ...(parameters.challenges
      ? { challenges: parameters.challenges.map((challenge) => snapshotValue(challenge)) }
      : {}),
    error: parameters.error,
    init: snapshotInit(parameters.init),
    input: snapshotInput(parameters.input),
    ...(parameters.method ? { method: snapshotMethod(parameters.method) } : {}),
    ...(parameters.response !== undefined
      ? { response: snapshotResponse(parameters.response) }
      : {}),
  }) as never
}

function snapshotInit<methods extends readonly Method.AnyClient[]>(
  init: from.RequestInit<methods> | undefined,
): from.RequestInit<methods> | undefined {
  if (!init) return undefined
  return freezeSnapshot({
    ...init,
    ...(init.headers ? { headers: new Headers(init.headers) } : {}),
  }) as from.RequestInit<methods>
}

function snapshotInput(input: RequestInfo | URL | undefined): RequestInfo | URL | undefined {
  if (input instanceof Request) return input.clone()
  if (input instanceof URL) return new URL(input)
  return input
}

function snapshotMethod<method extends Method.AnyClient>(method: method): method {
  return freezeSnapshot(Object.assign({}, method)) as method
}

function snapshotResponse<response>(response: response): response {
  if (response instanceof Response) return response.clone() as response
  return snapshotValue(response)
}

function snapshotValue<value>(value: value): value {
  try {
    return deepFreeze(structuredClone(value))
  } catch {
    return value
  }
}

function deepFreeze<value>(value: value): value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

function freezeSnapshot<value>(value: value): value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  return value
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
export function validateCredentialHeaderValue(credential: string): void {
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
