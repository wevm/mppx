import * as AttestationClient from '../attestation/Client.js'
import type * as Attestation from '../attestation/Types.js'
import type * as Challenge from '../Challenge.js'
import * as Constants from '../Constants.js'
import * as Expires from '../Expires.js'
import * as AcceptPayment from '../internal/AcceptPayment.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import * as Fetch from './internal/Fetch.js'
import * as MethodChallenge from './internal/MethodChallenge.js'
import * as Transport from './Transport.js'

export type Methods = readonly (Method.AnyClient | readonly Method.AnyClient[])[]
type EventResponseOf<transport extends Transport.AnyTransport> =
  | Response
  | Transport.ResponseOf<transport>
const preparedPaymentMethods = new WeakMap<object, Method.AnyClient>()

/**
 * A selected payment that can be inspected before its credential is created.
 *
 * Prepared payments retain transport-local protocol state and are not serializable.
 */
export type PreparedPayment<
  methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
  transport extends Transport.AnyTransport = Transport.Transport,
> = Readonly<{
  /** The selected payment challenge. */
  challenge: Challenge.Challenge
  /** All supported payment challenges extracted from the response. */
  challenges: readonly Challenge.Challenge[]
  /** Creates the selected challenge's credential at most once. */
  createCredential: (context?: AnyContextFor<methods> | undefined) => Promise<string>
  /** The configured client method selected for the challenge. */
  method: methods[number]
  /** Attaches a credential using the protocol that produced the selected challenge. */
  setCredential: (
    request: Transport.RequestOf<transport>,
    credential: string,
  ) => Transport.RequestOf<transport>
}>

/** A payment challenge prepared together with the exact HTTP request that produced it. */
export type PreparedRequest<methods extends readonly Method.AnyClient[]> = Readonly<
  PreparedPayment<methods, Transport.Transport<RequestInit, Response>> & {
    /** Exact request that returned the selected payment challenge. */
    request: Request
    /** Payment-required response returned for {@link request}. */
    response: Response
    /** Redirects followed before receiving the payment challenge. */
    redirects: readonly PreparedRequest.Redirect[]
    /** Creates and sends a credential to the prepared request without following redirects. */
    pay: (context?: AnyContextFor<methods> | undefined) => Promise<Response>
  }
>

export declare namespace PreparedRequest {
  /** A redirect followed while discovering a payment challenge. */
  type Redirect = Readonly<{
    from: string
    status: number
    to: string
  }>
}

/**
 * Client-side payment handler.
 */
export type Mppx<
  methods extends Methods = Methods,
  transport extends Transport.AnyTransport = Transport.Transport,
> = {
  /** Payment-aware fetch function that automatically handles 402 responses. */
  fetch: Fetch.from.Fetch<FlattenMethods<methods>>
  /** The original, unwrapped fetch function (pre-polyfill). Useful when you need to make requests that should not be intercepted (e.g. 402 probes for websocket auth). */
  rawFetch: typeof globalThis.fetch
  /** Methods to configure. */
  methods: FlattenMethods<methods>
  /** The transport used. */
  transport: transport
  /**
   * Selects a payment challenge without creating its credential.
   *
   * @example
   * ```ts
   * const request = { method: 'POST' }
   * const response = await mppx.rawFetch('/resource', request)
   * const payment = await mppx.preparePayment(response, { request })
   * inspect(payment.challenge)
   * const credential = await payment.createCredential()
   * const init = payment.setCredential(request, credential)
   * ```
   */
  preparePayment: (
    response: Transport.ResponseOf<transport>,
    options?: preparePayment.Options<FlattenMethods<methods>, transport> | undefined,
  ) => Promise<PreparedPayment<FlattenMethods<methods>, transport>>
  /**
   * Follows safe pre-payment redirects and prepares the challenge with the exact request that
   * produced it. Credential-bearing requests never follow redirects. Requires a runtime that
   * exposes manual redirect responses; browsers return opaque redirects and are not supported.
   */
  prepareRequest: transport extends Transport.Transport<RequestInit, Response>
    ? (
        input: RequestInfo | URL,
        init?: RequestInit | undefined,
        options?: prepareRequest.Options<FlattenMethods<methods>> | undefined,
      ) => Promise<PreparedRequest<FlattenMethods<methods>>>
    : never
  /** Creates a credential from a payment-required response by routing to the correct method. */
  createCredential: (
    response: Transport.ResponseOf<transport>,
    context?: AnyContextFor<FlattenMethods<methods>> | undefined,
    options?: createCredential.Options<FlattenMethods<methods>, transport> | undefined,
  ) => Promise<string>
  /** Register a client event handler by canonical event name. */
  on<name extends Fetch.ClientEventName<FlattenMethods<methods>, EventResponseOf<transport>>>(
    name: name,
    handler: Fetch.ClientEventHandler<FlattenMethods<methods>, name, EventResponseOf<transport>>,
  ): Fetch.Unsubscribe
  /** Register a handler for received payment challenges. */
  onChallengeReceived(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'challenge.received',
      EventResponseOf<transport>
    >,
  ): Fetch.Unsubscribe
  /** Register a handler for created credentials. */
  onCredentialCreated(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'credential.created',
      EventResponseOf<transport>
    >,
  ): Fetch.Unsubscribe
  /** Register a handler for failed automatic payment handling. */
  onPaymentFailed(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'payment.failed',
      EventResponseOf<transport>
    >,
  ): Fetch.Unsubscribe
  /** Register a handler for payment retry responses. */
  onPaymentResponse(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'payment.response',
      EventResponseOf<transport>
    >,
  ): Fetch.Unsubscribe
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
    attestation,
    maxPaymentRetries,
    onChallenge,
    orderChallenges,
    polyfill = true,
    acceptPaymentPolicy = polyfill && typeof globalThis.location !== 'undefined'
      ? 'same-origin'
      : 'always',
    transport = Transport.http() as transport,
  } = config

  const rawFetch = Fetch.unwrapFetch(config.fetch ?? globalThis.fetch)
  const attestationSigner = attestation
    ? createAttestationSigner(attestation as Attestation.SignerMap)
    : undefined
  const attestedFetch = attestationSigner
    ? AttestationClient.wrapFetch(rawFetch, attestationSigner)
    : rawFetch
  const methods = config.methods.flat() as unknown as FlattenMethods<methods>
  const acceptPayment = AcceptPayment.resolve(methods, config.paymentPreferences)
  const events = Fetch.createEventDispatcher<FlattenMethods<methods>, EventResponseOf<transport>>()

  const resolvedOnChallenge = onChallenge as Fetch.from.Config<
    FlattenMethods<methods>
  >['onChallenge']
  const config_fetch = {
    acceptPayment,
    acceptPaymentPolicy,
    ...((config.fetch || attestation) && { fetch: attestedFetch }),
    eventDispatcher: events,
    ...(maxPaymentRetries !== undefined && { maxPaymentRetries }),
    ...(resolvedOnChallenge && { onChallenge: resolvedOnChallenge }),
    ...(orderChallenges && { orderChallenges }),
    methods,
    transport,
  } satisfies Fetch.from.Config<FlattenMethods<methods>>
  const fetch = Fetch.from<FlattenMethods<methods>>(config_fetch)

  if (polyfill) Fetch.polyfill(config_fetch)

  function onChallengeReceived(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'challenge.received',
      EventResponseOf<transport>
    >,
  ) {
    return events.on('challenge.received', handler)
  }

  function onCredentialCreated(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'credential.created',
      EventResponseOf<transport>
    >,
  ) {
    return events.on('credential.created', handler)
  }

  function onPaymentFailed(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'payment.failed',
      EventResponseOf<transport>
    >,
  ) {
    return events.on('payment.failed', handler)
  }

  function onPaymentResponse(
    handler: Fetch.ClientEventHandler<
      FlattenMethods<methods>,
      'payment.response',
      EventResponseOf<transport>
    >,
  ) {
    return events.on('payment.response', handler)
  }

  async function preparePayment(
    response: Transport.ResponseOf<transport>,
    options?: preparePayment.Options<FlattenMethods<methods>, transport>,
  ): Promise<PreparedPayment<FlattenMethods<methods>, transport>> {
    const eventResponse = snapshotResponse(response)
    const challenges = await transport.getChallenges(response as never, options?.request as never)
    const challengeSnapshots = Object.freeze(
      challenges.map((candidate) => snapshotValue(candidate)),
    )
    const preferences = resolveChallengePreferences(acceptPayment.entries, options?.acceptPayment)

    let challenge: Challenge.Challenge | undefined
    let mi: FlattenMethods<methods>[number] | undefined
    try {
      const candidates = AcceptPayment.selectChallengeCandidates(challenges, methods, preferences)
      const orderedCandidates = await resolveChallengeOrder(
        candidates,
        options?.orderChallenges ?? orderChallenges,
      )
      const selected = orderedCandidates[0]
      if (!selected)
        throw new Error(
          `No method found for challenges: ${challenges.map((challenge) => `${challenge.method}.${challenge.intent}`).join(', ')}. Available: ${methods.map((m) => `${m.name}.${m.intent}`).join(', ')}`,
        )

      // Signing must use what the caller inspects, while attachment needs the adapter's original
      // object identity to retain protocol provenance.
      const transportChallenge = selected.challenge
      challenge = challengeSnapshots[selected.index]!
      mi = selected.method as FlattenMethods<methods>[number]
      if (challenge.expires) Expires.assert(challenge.expires, challenge.id)

      const selectedChallenge = challenge
      const selectedMethod = mi
      const createPreparedCredential = memoizeCreateCredential<FlattenMethods<methods>>(
        async (context) => {
          try {
            if (selectedChallenge.expires)
              Expires.assert(selectedChallenge.expires, selectedChallenge.id)

            const createCredential = memoizeCreateCredential<FlattenMethods<methods>>(
              (overrideContext) =>
                createCredentialForMethod(
                  selectedChallenge,
                  selectedMethod,
                  overrideContext ?? context,
                ),
            )
            const eventCredential = await events.emit(
              'challenge.received',
              createChallengeReceivedPayload({
                challenge: selectedChallenge,
                challenges,
                createCredential,
                method: selectedMethod,
                response: eventResponse,
              }),
            )
            const credential = eventCredential ?? (await createCredential())
            Fetch.validateCredentialHeaderValue(credential)
            await events.emit(
              'credential.created',
              createCredentialCreatedPayload({
                challenge: selectedChallenge,
                credential,
                method: selectedMethod,
                response: eventResponse,
              }),
            )
            return credential
          } catch (error) {
            await events.emit(
              'payment.failed',
              createPaymentFailedPayload({
                challenge: selectedChallenge,
                challenges,
                error,
                method: selectedMethod,
                response: eventResponse,
              }),
            )
            throw error
          }
        },
      )
      const prepared = Object.freeze({
        challenge: selectedChallenge,
        challenges: challengeSnapshots,
        createCredential: createPreparedCredential,
        method: snapshotMethod(selectedMethod),
        setCredential(request: Transport.RequestOf<transport>, credential: string) {
          Fetch.validateCredentialHeaderValue(credential)
          return transport.setCredential(request, credential, { challenge: transportChallenge })
        },
      })
      preparedPaymentMethods.set(prepared, selectedMethod)
      return prepared
    } catch (error) {
      await events.emit(
        'payment.failed',
        createPaymentFailedPayload({
          challenge,
          challenges,
          error,
          method: mi,
          response: eventResponse,
        }),
      )
      throw error
    }
  }

  async function prepareRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: prepareRequest.Options<FlattenMethods<methods>>,
  ): Promise<PreparedRequest<FlattenMethods<methods>>> {
    const { maxRedirects = 20, ...paymentOptions } = options ?? {}
    const preparedHttp = await prepareHttpRequest({
      acceptPayment: acceptPayment.header,
      acceptPaymentPolicy,
      fetch: rawFetch,
      init,
      input,
      maxRedirects,
      signer: attestationSigner,
    })
    const requestInit = requestToInit(preparedHttp.replayRequest, preparedHttp.body)
    if (!(await transport.isPaymentRequired(preparedHttp.response as never, requestInit as never)))
      throw new Error('Response does not require payment.')

    const payment = (await preparePayment(preparedHttp.response as never, {
      ...paymentOptions,
      request: requestInit as never,
    })) as unknown as PreparedPayment<
      FlattenMethods<methods>,
      Transport.Transport<RequestInit, Response>
    >

    const paymentMethod = preparedPaymentMethods.get(payment) ?? payment.method
    const createRequestCredential = memoizeCreateCredential(async (context) => {
      if (MethodChallenge.has(paymentMethod))
        await MethodChallenge.handle(paymentMethod, {
          challenge: payment.challenge,
          context,
          fetch: attestedFetch,
          input: preparedHttp.replayRequest,
        })
      return payment.createCredential(context)
    })

    return Object.freeze({
      ...payment,
      createCredential: createRequestCredential,
      request: preparedHttp.request,
      response: preparedHttp.response,
      redirects: preparedHttp.redirects,
      async pay(context?: AnyContextFor<FlattenMethods<methods>>) {
        const credential = await createRequestCredential(context)
        const paidInit = payment.setCredential(
          requestToInit(preparedHttp.replayRequest, preparedHttp.body),
          credential,
        )
        return attestedFetch(preparedHttp.replayRequest.url, {
          ...paidInit,
          redirect: 'manual',
        })
      },
    })
  }

  return {
    fetch,
    rawFetch,
    methods,
    transport,
    on: events.on,
    onChallengeReceived,
    onCredentialCreated,
    onPaymentFailed,
    onPaymentResponse,
    preparePayment,
    prepareRequest: prepareRequest as never,
    async createCredential(
      response: Transport.ResponseOf<transport>,
      context?: AnyContextFor<FlattenMethods<methods>>,
      options?: createCredential.Options<FlattenMethods<methods>, transport>,
    ) {
      const prepared = await preparePayment(response, options)
      return prepared.createCredential(context)
    },
  }
}

export declare namespace preparePayment {
  /** Options for selecting a payment without creating its credential. */
  type Options<
    methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
    transport extends Transport.AnyTransport = Transport.Transport,
  > = createCredential.Options<methods, transport>
}

export declare namespace prepareRequest {
  /** Options for preparing a request-bound payment. */
  type Options<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> = Omit<
    preparePayment.Options<methods, Transport.Transport<RequestInit, Response>>,
    'request'
  > & {
    /** Maximum redirects followed before rejecting the request. @default 20 */
    maxRedirects?: number | undefined
  }
}

export declare namespace createCredential {
  type Options<
    methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
    transport extends Transport.AnyTransport = Transport.Transport,
  > = {
    /** Request-local Accept-Payment override for manual rawFetch + createCredential flows. */
    acceptPayment?: string | readonly AcceptPayment.Entry[] | undefined
    /** Request-local challenge filtering and sorting. */
    orderChallenges?: AcceptPayment.OrderChallenges<methods> | undefined
    /** Request that produced the response, when challenge extraction depends on both values. */
    request?: Transport.RequestOf<transport> | undefined
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
    transport extends Transport.AnyTransport = Transport.Transport,
  > = {
    /** Request-attestation signers applied to every outbound HTTP attempt. */
    attestation?: transport extends Transport.Transport<RequestInit, Response>
      ? Attestation.SignerMap | undefined
      : never
    /** Controls when `Accept-Payment` is injected. */
    acceptPaymentPolicy?: Fetch.from.Config['acceptPaymentPolicy'] | undefined
    /** Custom fetch function to wrap. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch
    /** Called when a 402 challenge is received and no event handler supplies a credential. */
    onChallenge?:
      | ((
          challenge: Challenge.Challenge,
          helpers: {
            createCredential: (context?: AnyContextFor<FlattenMethods<methods>>) => Promise<string>
          },
        ) => Promise<string | undefined>)
      | undefined
    /** Maximum number of payment challenge retries after the initial response. @default 3 */
    maxPaymentRetries?: Fetch.from.Config['maxPaymentRetries'] | undefined
    /** Filters and sorts supported challenges before credential creation. */
    orderChallenges?: AcceptPayment.OrderChallenges<FlattenMethods<methods>> | undefined
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

function createAttestationSigner(signers: Attestation.SignerMap): Attestation.Signer {
  const values = Object.values(signers)
  if (values.length === 0)
    throw new TypeError('Mppx client attestation must configure at least one signer.')
  return AttestationClient.composeSigners(
    ...(values as [Attestation.Signer, ...Attestation.Signer[]]),
  )
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const bodyHeaders = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
  'transfer-encoding',
]
const crossOriginHeaders = [
  'authorization',
  'cookie',
  'cookie2',
  'host',
  'payment-authorization',
  'payment-signature',
  'proxy-authorization',
  'x-payment',
]

async function prepareHttpRequest(parameters: {
  acceptPayment: string
  acceptPaymentPolicy: NonNullable<Fetch.from.Config['acceptPaymentPolicy']>
  fetch: typeof globalThis.fetch
  init: RequestInit | undefined
  input: RequestInfo | URL
  maxRedirects: number
  signer: Attestation.Signer | undefined
}): Promise<{
  body: BodyInit | undefined
  replayRequest: Request
  request: Request
  response: Response
  redirects: readonly PreparedRequest.Redirect[]
}> {
  const { acceptPayment, acceptPaymentPolicy, fetch, init, input, maxRedirects, signer } =
    parameters
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0)
    throw new TypeError('maxRedirects must be a non-negative integer.')

  let request = new Request(input, { ...init, redirect: 'manual' })
  const explicitAcceptPayment = request.headers.has(Constants.Headers.acceptPayment)
  let body = await replayBody(request, init?.body)
  const redirects: PreparedRequest.Redirect[] = []

  for (;;) {
    request = withAcceptPayment(request, acceptPayment, explicitAcceptPayment, acceptPaymentPolicy)
    const sentRequest = signer ? await signer.sign(request.clone()) : request.clone()
    const response = await fetch(sentRequest)
    if (response.type === 'opaqueredirect' || response.status === 0)
      throw new Error('prepareRequest requires a runtime that exposes manual redirect responses.')
    if (!redirectStatuses.has(response.status))
      return {
        body,
        replayRequest: request,
        request: sentRequest,
        response,
        redirects: Object.freeze(redirects),
      }

    const location = response.headers.get('location')
    if (!location)
      return {
        body,
        replayRequest: request,
        request: sentRequest,
        response,
        redirects: Object.freeze(redirects),
      }
    if (redirects.length >= maxRedirects) {
      await response.body?.cancel()
      throw new Error(`Payment request exceeded ${maxRedirects} redirects.`)
    }

    const from = new URL(request.url)
    const to = new URL(location, from)
    if (from.protocol === 'https:' && to.protocol !== 'https:') {
      await response.body?.cancel()
      throw new Error(`Payment request refused HTTPS downgrade redirect to ${to.href}`)
    }

    const headers = new Headers(request.headers)
    let method = request.method
    const switchesToGet =
      ((response.status === 301 || response.status === 302) && method === 'POST') ||
      (response.status === 303 && method !== 'GET' && method !== 'HEAD')
    if (switchesToGet) {
      method = 'GET'
      body = undefined
      for (const header of bodyHeaders) headers.delete(header)
    }
    if (from.origin !== to.origin)
      for (const header of [...headers.keys()]) {
        const value = headers.get(header) ?? ''
        if (crossOriginHeaders.includes(header) || value.startsWith('Payment '))
          headers.delete(header)
      }

    redirects.push(Object.freeze({ from: from.href, status: response.status, to: to.href }))
    await response.body?.cancel()
    request = new Request(to, requestInit(request, headers, method, body))
  }
}

function requestToInit(request: Request, body: BodyInit | undefined): RequestInit {
  return requestInit(request, new Headers(request.headers), request.method, body)
}

async function replayBody(
  request: Request,
  suppliedBody: BodyInit | null | undefined,
): Promise<BodyInit | undefined> {
  if (typeof suppliedBody === 'string') return suppliedBody
  if (!request.body) return undefined
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  if (
    request.headers.has('mcp-method') ||
    (accept.includes('application/json') && accept.includes('text/event-stream'))
  )
    return request.clone().text()
  return request.clone().arrayBuffer()
}

function withAcceptPayment(
  request: Request,
  acceptPayment: string,
  explicit: boolean,
  policy: NonNullable<Fetch.from.Config['acceptPaymentPolicy']>,
): Request {
  if (explicit) return request
  const headers = new Headers(request.headers)
  headers.delete(Constants.Headers.acceptPayment)
  if (acceptPayment && Fetch.shouldInjectForPolicy(request, policy))
    headers.set(Constants.Headers.acceptPayment, acceptPayment)
  return new Request(request, { headers })
}

function requestInit(
  request: Request,
  headers: Headers,
  method: string,
  body: BodyInit | undefined,
): RequestInit {
  return {
    ...(body ? { body } : {}),
    cache: request.cache,
    credentials: request.credentials,
    headers,
    integrity: request.integrity,
    keepalive: request.keepalive,
    method,
    mode: request.mode,
    redirect: 'manual',
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
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
  method: methods[number]
  response: response
}): Fetch.ChallengeReceivedPayload<methods, response> {
  return Object.freeze({
    challenge: snapshotValue(parameters.challenge),
    challenges: parameters.challenges.map((challenge) => snapshotValue(challenge)),
    createCredential: parameters.createCredential,
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
  method: methods[number]
  response: response
}): Fetch.CredentialCreatedPayload<methods, response> {
  return Object.freeze({
    challenge: snapshotValue(parameters.challenge),
    credential: parameters.credential,
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
  method?: methods[number] | undefined
  response: response
}): Fetch.PaymentFailedPayload<methods, response> {
  return Object.freeze({
    ...(parameters.challenge ? { challenge: snapshotValue(parameters.challenge) } : {}),
    ...(parameters.challenges
      ? { challenges: parameters.challenges.map((challenge) => snapshotValue(challenge)) }
      : {}),
    error: parameters.error,
    ...(parameters.method ? { method: snapshotMethod(parameters.method) } : {}),
    response: snapshotResponse(parameters.response),
  }) as never
}

function snapshotMethod<method extends Method.AnyClient>(method: method): method {
  return freezeSnapshot(Object.assign({}, method)) as method
}

function snapshotResponse<response>(response: response): response {
  if (response instanceof Response) {
    try {
      return response.clone() as response
    } catch {
      // A consumed body cannot be cloned, but status and headers are sufficient for event context.
      return new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }) as response
    }
  }
  return snapshotValue(response)
}

function snapshotValue<value>(value: value): value {
  try {
    const snapshot = structuredClone(value)
    // Protocol adapters may attach non-enumerable symbol metadata to otherwise plain challenges.
    if (value && snapshot && typeof value === 'object' && typeof snapshot === 'object')
      for (const symbol of Object.getOwnPropertySymbols(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, symbol)
        if (descriptor) Object.defineProperty(snapshot, symbol, descriptor)
      }
    return deepFreeze(snapshot)
  } catch {
    return freezeSnapshot(value)
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

async function resolveChallengeOrder<methods extends readonly Method.AnyClient[]>(
  candidates: readonly AcceptPayment.ChallengeCandidate<methods[number]>[],
  orderChallenges: AcceptPayment.OrderChallenges<methods> | undefined,
): Promise<readonly AcceptPayment.ChallengeCandidate<methods[number]>[]> {
  return orderChallenges ? orderChallenges(candidates) : candidates
}

async function createCredentialForMethod(
  challenge: Challenge.Challenge,
  mi: Method.AnyClient,
  context: unknown,
): Promise<string> {
  const parsedContext = mi.context && context !== undefined ? mi.context.parse(context) : undefined
  return mi.createCredential(
    parsedContext !== undefined ? { challenge, context: parsedContext } : ({ challenge } as never),
  )
}
