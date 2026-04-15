import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDeepStrictEqual } from 'node:util'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import * as Expires from '../Expires.js'
import * as AcceptPayment from '../internal/AcceptPayment.js'
import * as Env from '../internal/env.js'
import type * as Method from '../Method.js'
import * as PaymentRequest from '../PaymentRequest.js'
import type * as Receipt from '../Receipt.js'
import type * as z from '../zod.js'
import * as Html from './internal/html/config.js'
import { serviceWorker } from './internal/html/serviceWorker.gen.js'
import * as NodeListener from './NodeListener.js'
import * as Request from './Request.js'
import * as Transport from './Transport.js'

export type Methods = readonly (Method.AnyServer | readonly Method.AnyServer[])[]

/**
 * Payment handler.
 */
export type Mppx<
  methods extends Methods = Methods,
  transport extends Transport.AnyTransport = Transport.Http,
> = {
  /** Methods to configure. */
  methods: FlattenMethods<methods>
  /** Server realm (e.g., hostname). */
  realm: string
  /** The transport used. */
  transport: transport
} & (transport extends Transport.Http
  ? {
      /**
       * Combines multiple method handlers into a single route handler that presents
       * all methods to the client via multiple `WWW-Authenticate` headers.
       *
       * Each entry is a `[method, options]` tuple where `method` is one of the
       * server methods passed to `Mppx.create()`, looked up by `name`+`intent`.
       *
       * Only available on HTTP transports.
       *
       * @example
       * ```ts
       * import { Mppx, tempo, stripe } from 'mppx/server'
       *
       * const mppx = Mppx.create({
       *   methods: [
       *     tempo.charge({ currency: USDC, recipient: '0x...' }),
       *     stripe.charge({ currency: 'usd' }),
       *   ],
       *   secretKey,
       * })
       *
       * app.get('/api/resource', async (req) => {
       *   const result = await mppx.compose(
       *     mppx.tempo.charge({ amount: '100' }),
       *     mppx.stripe.charge({ amount: '100' }),
       *   )(req)
       *   if (result.status === 402) return result.challenge
       *   return result.withReceipt(new Response('OK'))
       * })
       * ```
       */
      compose(
        ...entries: ComposeEntry<FlattenMethods<methods>>[]
      ): (input: Request) => Promise<MethodFn.Response<Transport.Http>>
    }
  : {}) &
  Handlers<FlattenMethods<methods>, transport> & {
    /**
     * Generate Challenge objects for registered methods without going through
     * the HTTP 402 request lifecycle. Uses the same options, defaults, and
     * schema transforms as the corresponding intent handler.
     *
     * @example
     * ```ts
     * const challenge = await mppx.challenge.tempo.charge({ amount: '25.92' })
     * ```
     */
    challenge: ChallengeHandlers<FlattenMethods<methods>>

    /**
     * Verify a credential string or object end-to-end: deserialize,
     * HMAC-check, match to a registered method, validate payload schema,
     * check expiry, and call the method's verify function.
     *
     * @example
     * ```ts
     * const receipt = await mppx.verifyCredential('eyJjaGFsbGVuZ2...')
     * const receipt = await mppx.verifyCredential(credential)
     * ```
     */
    verifyCredential(credential: string | Credential.Credential): Promise<Receipt.Receipt>
  }

/** Extracts the transport override from a method, if any. */
type TransportOverrideOf<mi> = mi extends { transport?: infer transport }
  ? Exclude<transport, undefined> extends Transport.AnyTransport
    ? Exclude<transport, undefined>
    : never
  : never

/** Resolves the effective transport for a method: override if present, else global default. */
type EffectiveTransportOf<mi, defaultTransport extends Transport.AnyTransport> = [
  TransportOverrideOf<mi>,
] extends [never]
  ? defaultTransport
  : TransportOverrideOf<mi>

/** True when exactly one method has the given intent (no name collision). */
type IsUniqueIntent<methods extends readonly Method.AnyServer[], intent extends string> =
  Extract<methods[number], { intent: intent }> extends infer M
    ? M extends M
      ? [Exclude<Extract<methods[number], { intent: intent }>, M>] extends [never]
        ? true
        : false
      : never
    : never

/** Only includes shorthand intent keys when the intent is unique across methods. */
type UniqueIntentHandlers<
  methods extends readonly Method.AnyServer[],
  transport extends Transport.AnyTransport,
> = {
  [method_name in methods[number]['intent'] as IsUniqueIntent<methods, method_name> extends true
    ? method_name
    : never]: MethodFn<
    Extract<methods[number], { intent: method_name }>,
    EffectiveTransportOf<Extract<methods[number], { intent: method_name }>, transport>,
    NonNullable<Extract<methods[number], { intent: method_name }>['defaults']>
  >
}

/** Nested handlers: `mppx.tempo.charge(...)`, grouped by method name then intent. */
type NestedHandlers<
  methods extends readonly Method.AnyServer[],
  transport extends Transport.AnyTransport,
> = {
  [name in methods[number]['name']]: {
    [mi in Extract<methods[number], { name: name }> as mi['intent']]: MethodFn<
      mi,
      EffectiveTransportOf<mi, transport>,
      NonNullable<mi['defaults']>
    > & { _method: mi }
  }
}

type Handlers<
  methods extends readonly Method.AnyServer[],
  transport extends Transport.AnyTransport,
> = {
  [mi in methods[number] as `${mi['name']}/${mi['intent']}`]: MethodFn<
    mi,
    EffectiveTransportOf<mi, transport>,
    NonNullable<mi['defaults']>
  >
} & UniqueIntentHandlers<methods, transport> &
  NestedHandlers<methods, transport>

/** Nested challenge generators: `mppx.challenge.tempo.charge(...)`. */
type ChallengeHandlers<methods extends readonly Method.AnyServer[]> = {
  [name in methods[number]['name']]: {
    [mi in Extract<methods[number], { name: name }> as mi['intent']]: ChallengeFn<
      mi,
      NonNullable<mi['defaults']>
    >
  }
}

/** A function that generates a Challenge object from intent options. */
type ChallengeFn<method extends Method.Method, defaults extends Record<string, unknown>> = (
  options: MethodFn.Options<method, defaults>,
) => Promise<Challenge.Challenge>

/**
 * Creates a server-side payment handler from methods.
 *
 * It is highly recommended to set a `secretKey` to bind challenges to their contents,
 * and allow the server to verify that incoming credentials match challenges it issued.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/server'
 *
 * const payment = Mppx.create({
 *   methods: [tempo()],
 *   secretKey: process.env.PAYMENT_SECRET_KEY,
 * })
 * ```
 */
export function create<
  const methods extends Methods,
  const transport extends Transport.AnyTransport = Transport.Http,
>(config: create.Config<methods, transport>): Mppx<methods, transport> {
  const {
    realm = Env.get('realm'),
    secretKey = Env.get('secretKey'),
    transport = Transport.http() as transport,
  } = config

  if (!secretKey) {
    throw new Error(
      'Missing secret key. Set the MPP_SECRET_KEY environment variable or pass `secretKey` to Mppx.create().',
    )
  }

  const methods = config.methods.flat() as unknown as FlattenMethods<methods>

  const handlers: Record<string, unknown> = {}
  const intentCount: Record<string, number> = {}

  for (const mi of methods) {
    intentCount[mi.intent] = (intentCount[mi.intent] ?? 0) + 1
    handlers[`${mi.name}/${mi.intent}`] = createMethodFn({
      defaults: mi.defaults,
      method: mi,
      realm,
      request: mi.request as never,
      respond: mi.respond as never,
      secretKey,
      transport: (mi.transport ?? transport) as never,
      verify: mi.verify as never,
    })
  }

  // Also set shorthand intent key when there's no collision
  for (const mi of methods) {
    if (intentCount[mi.intent] === 1) handlers[mi.intent] = handlers[`${mi.name}/${mi.intent}`]
  }

  // Build nested handlers: mppx.tempo.charge(...)
  for (const mi of methods) {
    if (!handlers[mi.name]) handlers[mi.name] = {}
    const fn = handlers[`${mi.name}/${mi.intent}`] as AnyMethodFn & { _method?: Method.AnyServer }
    fn._method = mi
    ;(handlers[mi.name] as Record<string, unknown>)[mi.intent] = fn
  }

  // Build challenge generators: mppx.challenge.tempo.charge(...)
  const challengeHandlers: Record<string, Record<string, unknown>> = {}
  for (const mi of methods) {
    if (!challengeHandlers[mi.name]) challengeHandlers[mi.name] = {}
    challengeHandlers[mi.name]![mi.intent] = createChallengeFn({
      defaults: mi.defaults,
      method: mi,
      realm,
      request: mi.request as never,
      secretKey,
    })
  }

  // verifyCredential: single-call end-to-end verification
  async function verifyCredentialFn(
    input: string | Credential.Credential,
  ): Promise<Receipt.Receipt> {
    const credential = typeof input === 'string' ? Credential.deserialize(input) : input

    // HMAC provenance check (secretKey is guaranteed non-null by the guard at the top of create())
    if (!Challenge.verify(credential.challenge, { secretKey: secretKey! }))
      throw new Errors.InvalidChallengeError({
        id: credential.challenge.id,
        reason: 'challenge was not issued by this server',
      })

    // Expiry check
    Expires.assert(credential.challenge.expires, credential.challenge.id)

    // Find matching method by name + intent
    const { method: credMethod, intent: credIntent } = credential.challenge
    const mi = (methods as readonly Method.AnyServer[]).find(
      (m) => m.name === credMethod && m.intent === credIntent,
    )
    if (!mi)
      throw new Errors.InvalidChallengeError({
        id: credential.challenge.id,
        reason: `no registered method for ${credMethod}/${credIntent}`,
      })

    // Validate payload against method schema
    mi.schema.credential.payload.parse(credential.payload)

    // The challenge already contains the request params (HMAC-bound),
    // so we use them directly — no need for the caller to re-supply.
    const request = credential.challenge.request as z.input<typeof mi.schema.request>

    return mi.verify({ credential, request } as never)
  }

  function composeFn(
    ...entries: readonly [
      Method.AnyServer | AnyMethodFnWithMethod | string,
      Record<string, unknown>,
    ][]
  ) {
    if (transport.name !== 'http') throw new Error('compose() only supports HTTP transport')
    if (entries.length === 0) throw new Error('compose() requires at least one entry')
    const configured = entries.map(([methodOrKey, options]) => {
      const key =
        typeof methodOrKey === 'string'
          ? methodOrKey
          : typeof methodOrKey === 'function' && '_method' in methodOrKey
            ? `${(methodOrKey._method as Method.AnyServer).name}/${(methodOrKey._method as Method.AnyServer).intent}`
            : `${(methodOrKey as Method.AnyServer).name}/${(methodOrKey as Method.AnyServer).intent}`
      const handlerFn = handlers[key] as AnyMethodFn | undefined
      if (!handlerFn)
        throw new Error(`No handler for "${key}". Is this method in your methods array?`)
      return handlerFn(options)
    })
    return compose(...(configured as ConfiguredHandler[]))
  }

  return {
    methods,
    challenge: challengeHandlers,
    compose: composeFn,
    realm: realm as string | undefined,
    transport,
    verifyCredential: verifyCredentialFn,
    ...handlers,
  } as never
}

export declare namespace create {
  type Config<
    methods extends Methods = Methods,
    transport extends Transport.AnyTransport = Transport.Http,
  > = {
    /** Array of configured methods. @example [tempo()] */
    methods: methods
    /** Server realm (e.g., hostname). Resolution order: explicit value > env vars (`MPP_REALM`, `FLY_APP_NAME`, `VERCEL_URL`, etc.) > request URL hostname > `"MPP Payment"`. */
    realm?: string | undefined
    /** Secret key for HMAC-bound challenge IDs for stateless verification. Auto-detected from `MPP_SECRET_KEY` environment variable. Throws if neither provided nor set. */
    secretKey?: string | undefined
    /** Transport to use. @default Transport.http() */
    transport?: transport | undefined
  }
}

function createMethodFn<
  method extends Method.Method,
  transport extends Transport.AnyTransport,
  defaults extends Record<string, unknown>,
>(
  parameters: createMethodFn.Parameters<method, transport, defaults>,
): createMethodFn.ReturnType<method, transport, defaults>
// biome-ignore lint/correctness/noUnusedVariables: _
function createMethodFn(parameters: createMethodFn.Parameters): createMethodFn.ReturnType {
  const { defaults, method, realm, respond, secretKey, transport, verify } = parameters

  return (options) => {
    const { description, meta, ...rest } = options
    const merged = { ...defaults, ...rest }

    return Object.assign(
      async (input: Transport.InputOf): Promise<MethodFn.Response> => {
        const expires =
          'expires' in options ? (options.expires as string | undefined) : Expires.minutes(5)
        const capturedRequest = await captureRequest(transport, input)

        // Extract credential once — getCredential may have side effects (e.g. SSE transports).
        const [credential, credentialError] = (() => {
          try {
            return [
              transport.getCredential(input) as Credential.Credential | null,
              undefined,
            ] as const
          } catch (e) {
            return [null, e as Error] as const
          }
        })()

        // Transform request if method provides a `request` function.
        const request = (
          parameters.request
            ? await parameters.request({ capturedRequest, credential, request: merged } as never)
            : merged
        ) as never

        // Resolve realm: explicit > env var > request Host header.
        const effectiveRealm = realm ?? resolveRealmFromCapturedRequest(capturedRequest)

        // Recompute challenge from options. The HMAC-bound ID means we don't need to
        // store challenges server-side—if the client echoes back a credential with
        // a matching ID, we know it was issued by us with these exact parameters.
        const challenge = Challenge.fromMethod(method, {
          description,
          expires,
          meta,
          realm: effectiveRealm,
          request,
          secretKey,
        })

        // Credential was provided but malformed
        if (credentialError) {
          const reason = getSafeCredentialReason(credentialError)
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.MalformedCredentialError(reason ? { reason } : {}),
            html: method.html,
          })
          return { challenge: response, status: 402 }
        }

        // No credential provided—issue challenge
        if (!credential) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.PaymentRequiredError({ description }),
            html: method.html,
          })
          return { challenge: response, status: 402 }
        }

        // ── Tier 1: HMAC provenance check (primary gate) ──────────────────
        //
        // Recompute the HMAC-SHA256 over the credential's echoed challenge
        // parameters (realm|method|intent|request|expires|digest|opaque) and
        // compare to the echoed `id`. This proves the challenge was issued by
        // this server with these exact parameters — including opaque/meta,
        // expires, and the full serialized request blob.
        //
        // This is the authoritative binding per §5.1.2.1.1 of the spec
        // (https://paymentauth.org/draft-httpauth-payment-00.html#section-5.1.2.1.1).
        // No database lookup is needed; the HMAC is stateless verification.
        if (!Challenge.verify(credential.challenge, { secretKey })) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.InvalidChallengeError({
              id: credential.challenge.id,
              reason: 'challenge was not issued by this server',
            }),
            html: method.html,
          })
          return { challenge: response, status: 402 }
        }

        // ── Tier 2: Pinned field safety net ──────────────────────────────
        //
        // The HMAC check above (Tier 1) is the primary gate — it already
        // covers ALL challenge fields including opaque, digest, and the full
        // serialized request. So why this second check?
        //
        // The `request()` hook can produce credential-dependent output: for
        // example, `feePayer` may differ between the 402 challenge call (no
        // credential) and the credential-bearing call. This means the
        // recomputed challenge here has a different `request` blob — and
        // thus a different HMAC — than the original challenge the client
        // echoes back. The HMAC check above verifies the *echoed* challenge
        // was signed by us, but it cannot verify that the echoed challenge
        // matches *this route's current configuration* when the request
        // hook transforms fields between calls.
        //
        // This check compares only the economically significant "pinned"
        // fields (method, intent, realm, amount, currency, recipient, etc.)
        // that MUST be stable across both calls. Fields like `opaque`,
        // `digest`, and `expires` don't need explicit pinning here because
        // they are set by server config (not derived from the request hook)
        // and are already fully covered by the HMAC binding in Tier 1.
        {
          const mismatch = getPinnedChallengeMismatch(challenge, credential.challenge)
          if (mismatch) {
            const response = await transport.respondChallenge({
              challenge,
              input,
              error: new Errors.InvalidChallengeError({
                id: credential.challenge.id,
                reason: `credential ${mismatch} does not match this route's requirements`,
              }),
              html: method.html,
            })
            return { challenge: response, status: 402 }
          }
        }

        // Reject credentials without expires (fail-closed) or with expired timestamp
        try {
          Expires.assert(credential.challenge.expires, credential.challenge.id)
        } catch (error) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: error as Errors.PaymentError,
          })
          return { challenge: response, status: 402 }
        }
        // Validate payload structure against method schema
        try {
          method.schema.credential.payload.parse(credential.payload)
        } catch {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.InvalidPayloadError(),
          })
          return { challenge: response, status: 402 }
        }

        const envelope: Method.VerifiedChallengeEnvelope = Object.freeze({
          capturedRequest,
          challenge: credential.challenge,
          credential,
        })

        // User-provided verification (e.g., check signature, submit tx, verify payment).
        // If verification fails, re-issue the challenge so the client can retry.
        let receiptData: Receipt.Receipt
        try {
          receiptData = await verify({ credential, envelope, request } as never)
        } catch (e) {
          if (!(e instanceof Errors.PaymentError))
            console.error('mppx: internal verification error', e)
          const error = e instanceof Errors.PaymentError ? e : new Errors.VerificationFailedError()
          const response = await transport.respondChallenge({
            challenge,
            input,
            error,
          })
          return { challenge: response, status: 402 }
        }

        // If the method's `respond` hook returns a Response, it means this
        // request is a management action (e.g. channel open, voucher POST)
        // and the user's route handler should NOT run. `withReceipt()` will
        // return the management response directly. If undefined, `withReceipt()`
        // expects the caller to pass the user handler's response instead.
        const managementResponse = respond
          ? await respond({ credential, envelope, input, receipt: receiptData, request } as never)
          : undefined

        return {
          status: 200,
          withReceipt<response>(response?: response) {
            if (managementResponse) {
              return transport.respondReceipt({
                challengeId: credential.challenge.id,
                credential,
                envelope,
                input,
                receipt: receiptData,
                response: managementResponse as never,
              }) as response
            }
            if (!response) throw new Error('withReceipt() requires a response argument')
            return transport.respondReceipt({
              challengeId: credential.challenge.id,
              credential,
              envelope,
              input,
              receipt: receiptData,
              response: response as never,
            }) as response
          },
        }
      },
      {
        _internal: {
          ...method,
          ...defaults,
          ...options,
          name: method.name,
          intent: method.intent,
          _canonicalRequest: PaymentRequest.fromMethod(method, merged),
        },
      },
    )
  }
}

/**
 * Creates a challenge generator for a single method+intent.
 * Applies the same defaults and request transform as createMethodFn,
 * but returns a Challenge object directly instead of a request handler.
 */
function createChallengeFn(parameters: {
  defaults?: Record<string, unknown>
  method: Method.Method
  realm: string | undefined
  request?: Method.RequestFn<Method.Method>
  secretKey: string
}): (options: Record<string, unknown>) => Promise<Challenge.Challenge> {
  const { defaults, method, realm, secretKey } = parameters

  return async (options) => {
    const { description, meta, ...rest } = options as {
      description?: string
      expires?: string
      meta?: Record<string, string>
      [key: string]: unknown
    }
    const merged = { ...defaults, ...rest }
    const expires =
      'expires' in options ? (options.expires as string | undefined) : Expires.minutes(5)

    // Transform request if method provides a `request` function.
    const request = (
      parameters.request
        ? await (parameters.request as (opts: { request: unknown }) => unknown)({
            request: merged,
          })
        : merged
    ) as never

    const effectiveRealm = realm ?? defaultRealm

    return Challenge.fromMethod(method, {
      description,
      expires,
      meta,
      realm: effectiveRealm,
      request,
      secretKey,
    })
  }
}

function getSafeCredentialReason(error: unknown): string | undefined {
  if (error instanceof Credential.InvalidCredentialEncodingError) return error.message
  if (error instanceof Credential.MissingAuthorizationHeaderError) return error.message
  if (error instanceof Credential.MissingPaymentSchemeError) return error.message
  return undefined
}

declare namespace createMethodFn {
  type Parameters<
    method extends Method.Method = Method.Method,
    transport extends Transport.AnyTransport = Transport.Http,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = {
    defaults?: defaults
    method: method
    realm: string | undefined
    request?: Method.RequestFn<method>
    respond?: Method.RespondFn<method>
    secretKey: string
    transport: transport
    verify: Method.VerifyFn<method>
  }

  type ReturnType<
    method extends Method.Method = Method.Method,
    transport extends Transport.AnyTransport = Transport.Http,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = MethodFn<method, transport, defaults>
}

const defaultRealm = 'MPP Payment'
const Warnings = {
  realmFallback: 'realm-fallback',
} as const

const _warned = new Set<string>()
function warnOnce(key: string, message: string) {
  if (_warned.has(key)) return
  _warned.add(key)
  console.warn(`[mppx] ${message}`)
}

/** Extracts hostname from the captured request URL, falling back to a default. */
function resolveRealmFromCapturedRequest(capturedRequest: Method.CapturedRequest): string {
  try {
    const { protocol, hostname } = capturedRequest.url
    if (/^https?:$/.test(protocol) && hostname) return hostname
  } catch {}
  warnOnce(
    Warnings.realmFallback,
    `Could not auto-detect realm from request. Falling back to "${defaultRealm}". Set \`realm\` in Mppx.create() or the MPP_REALM env var.`,
  )
  return defaultRealm
}

/**
 * Captures the transport request into a frozen snapshot at the start of the
 * verification flow. This snapshot is threaded through request() → verify() →
 * respond() → respondReceipt() so every hook sees the same authoritative
 * request state — preventing the raw transport input from being re-read or
 * mutated between verification steps.
 *
 * Note: Object.freeze is shallow — it prevents reassigning top-level properties
 * but does not deep-freeze mutable class instances like Headers or URL. This is
 * an accidental-mutation guard for trusted server hooks, not a security boundary.
 */
async function captureRequest(
  transport: Transport.AnyTransport,
  input: unknown,
): Promise<Method.CapturedRequest> {
  const capturedRequest = transport.captureRequest
    ? await transport.captureRequest(input)
    : captureRequestFromInput(input)

  return Object.freeze(capturedRequest)
}

function captureRequestFromInput(input: unknown): Method.CapturedRequest {
  const source = input as {
    headers?: HeadersInit | undefined
    method?: string | undefined
    url?: string | URL | undefined
  }

  return {
    headers: new Headers(source.headers),
    method: source.method ?? 'POST',
    url: Transport.safeUrl(source.url),
  }
}

const coreBindingFields = ['amount', 'currency', 'recipient'] as const
const methodBindingFields = ['chainId', 'memo', 'splits'] as const
const pinnedRequestBindingFields = [...coreBindingFields, ...methodBindingFields] as const

type CoreBindingField = (typeof coreBindingFields)[number]
type MethodBindingField = (typeof methodBindingFields)[number]
type PinnedRequestBindingField = (typeof pinnedRequestBindingFields)[number]
type PinnedChallengeField = 'method' | 'intent' | 'realm' | PinnedRequestBindingField

/**
 * Compares only the fields that MUST be stable across request-hook transforms.
 *
 * This is NOT the primary integrity check — the HMAC binding (Challenge.verify)
 * already covers every challenge field including opaque, digest, and the full
 * serialized request. This function exists as a secondary safety net for the
 * case where the `request()` hook produces credential-dependent output, causing
 * the recomputed challenge to differ from the original in non-economic fields
 * (e.g. `feePayer`). We only need to verify that the economically significant
 * subset hasn't drifted.
 */
function getPinnedChallengeMismatch(
  expectedChallenge: Challenge.Challenge,
  actualChallenge: Challenge.Challenge,
): PinnedChallengeField | undefined {
  for (const field of ['method', 'intent', 'realm'] as const) {
    if (actualChallenge[field] !== expectedChallenge[field]) return field
  }

  return getPinnedRequestBindingMismatch(
    expectedChallenge.request as Record<string, unknown>,
    actualChallenge.request as Record<string, unknown>,
  )
}

function getPinnedRequestBindingMismatch(
  expectedRequest: Record<string, unknown>,
  actualRequest: Record<string, unknown>,
): PinnedRequestBindingField | undefined {
  const expected = getPinnedRequestBinding(expectedRequest)
  const actual = getPinnedRequestBinding(actualRequest)

  return (
    getCoreBindingMismatch(expected.coreBinding, actual.coreBinding) ??
    getMethodBindingMismatch(expected.methodBinding, actual.methodBinding)
  )
}

function getCoreBindingMismatch(
  expected: CoreBinding,
  actual: CoreBinding,
): CoreBindingField | undefined {
  return coreBindingFields.find((field) => !isDeepStrictEqual(expected[field], actual[field]))
}

function getMethodBindingMismatch(
  expected: MethodBinding,
  actual: MethodBinding,
): MethodBindingField | undefined {
  return methodBindingFields.find((field) => !isDeepStrictEqual(expected[field], actual[field]))
}

function getPinnedRequestBinding(request: Record<string, unknown>): PinnedRequestBinding {
  const methodDetails = (request.methodDetails ?? {}) as Record<string, unknown>
  const amount = normalizeScalar(request.amount ?? methodDetails.amount)
  const chainId = normalizeScalar(request.chainId ?? methodDetails.chainId)
  const currency = normalizeScalar(request.currency ?? methodDetails.currency)
  const memo = normalizeHex(methodDetails.memo)
  const recipient = normalizeScalar(request.recipient ?? methodDetails.recipient)
  const splits = normalizeComparable(methodDetails.splits)

  return {
    coreBinding: {
      ...(amount !== undefined ? { amount } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
    },
    methodBinding: {
      ...(chainId !== undefined ? { chainId } : {}),
      ...(memo !== undefined ? { memo } : {}),
      ...(splits !== undefined ? { splits } : {}),
    },
  }
}

function normalizeScalar(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value)
}

function normalizeHex(value: unknown): string | undefined {
  if (value === undefined) return undefined

  const normalized = String(value)
  return normalized.startsWith('0x') ? normalized.toLowerCase() : normalized
}

function normalizeComparable(value: unknown): unknown {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map(normalizeComparable)

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeComparable(nested)]),
    )
  }

  return typeof value === 'string' ? normalizeHex(value) : value
}

type CoreBinding = {
  [field in CoreBindingField]?: string
}

type MethodBinding = {
  [field in MethodBindingField]?: unknown
}

type PinnedRequestBinding = {
  coreBinding: CoreBinding
  methodBinding: MethodBinding
}

export type MethodFn<
  method extends Method.Method,
  transport extends Transport.AnyTransport,
  defaults extends Record<string, unknown>,
> = (
  options: MethodFn.Options<method, defaults>,
) => (input: Transport.InputOf<transport>) => Promise<MethodFn.Response<transport>>
/** @internal */
export type AnyMethodFn = (options: any) => (input: any) => Promise<any>
/** A MethodFn tagged with its source Method (set by `create()`). @internal */
type AnyMethodFnWithMethod = AnyMethodFn & { _method: Method.AnyServer }

/** @internal */
declare namespace MethodFn {
  export type Options<
    method extends Method.Method,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = {
    /** Optional human-readable description of the payment. */
    description?: string | undefined
    /** Optional challenge expiration timestamp (ISO 8601). */
    expires?: string | undefined
    /** Optional server-defined correlation data (serialized as `opaque` in the request). Flat string-to-string map; clients MUST NOT modify. */
    meta?: Record<string, string> | undefined
  } & Method.WithDefaults<z.input<method['schema']['request']>, defaults>

  export type Response<transport extends Transport.AnyTransport = Transport.Http> =
    | {
        challenge: Transport.ChallengeOutputOf<transport>
        status: 402
      }
    | {
        status: 200
        withReceipt: Transport.WithReceipt<transport>
      }
}

/** A configured handler — the return value of e.g. `mppx.charge({ ... })`. @internal */
type ConfiguredHandler = ((input: Request) => Promise<MethodFn.Response<Transport.Http>>) & {
  _internal: {
    name: string
    intent: string
    html: Html.Options | undefined
    _canonicalRequest: Record<string, unknown>
  }
}

/** An entry for `compose()`: a method reference, handler function ref, or string key paired with its options. */
type ComposeEntry<methods extends readonly Method.AnyServer[]> =
  | {
      [i in keyof methods]: readonly [
        methods[i],
        MethodFn.Options<methods[i], NonNullable<methods[i]['defaults']>>,
      ]
    }[number]
  | {
      [i in keyof methods]: readonly [
        `${methods[i]['name']}/${methods[i]['intent']}`,
        MethodFn.Options<methods[i], NonNullable<methods[i]['defaults']>>,
      ]
    }[number]
  | {
      [i in keyof methods]: readonly [
        MethodFn<methods[i], any, any> & { _method: methods[i] },
        MethodFn.Options<methods[i], NonNullable<methods[i]['defaults']>>,
      ]
    }[number]

/**
 * Combines multiple configured payment handlers into a single route handler
 * that presents all methods to the client via multiple `WWW-Authenticate` headers.
 *
 * When no credential is present, all handlers are called and their challenges
 * are merged into a single 402 response. When a credential is present, it is
 * dispatched to the handler matching the credential's `method`+`intent`.
 *
 * @example
 * ```ts
 * import { Mppx, tempo, stripe } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo(), stripe()],
 *   secretKey: process.env.PAYMENT_SECRET_KEY,
 * })
 *
 * app.get('/api/resource', async (req) => {
 *   const result = await Mppx.compose(
 *     mppx['tempo/charge']({ amount: '100', currency: USDC, recipient: '0x...' }),
 *     mppx['stripe/charge']({ amount: '100', currency: 'usd' }),
 *   )(req)
 *   if (result.status === 402) return result.challenge
 *   return result.withReceipt(new Response('OK'))
 * })
 * ```
 */
type ComposeHtmlOptions = Html.Config

export function compose(
  ...args: readonly unknown[]
): (input: Request) => Promise<MethodFn.Response<Transport.Http>> {
  // Extract optional html options from last argument
  const last = args[args.length - 1]
  const composeOptions: Html.Options | undefined =
    typeof last === 'object' &&
    last !== null &&
    typeof last !== 'function' &&
    !('_internal' in last)
      ? (() => {
          const opts = last as ComposeHtmlOptions
          return {
            config: {},
            content: '',
            formatAmount: () => '',
            text: opts.text,
            theme: opts.theme,
          }
        })()
      : undefined
  const handlers = (composeOptions ? args.slice(0, -1) : args) as readonly ((
    input: Request,
  ) => Promise<MethodFn.Response<Transport.Http>>)[]

  if (handlers.length === 0) throw new Error('compose() requires at least one handler')

  return async (input: Request) => {
    // Serve service worker for html-enabled compose
    if (new URL(input.url).searchParams.has(Html.params.serviceWorker)) {
      const hasHtml = handlers.some((h) => (h as ConfiguredHandler)._internal?.html)
      if (hasHtml)
        return {
          status: 402,
          challenge: new Response(serviceWorker, {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript',
              'Cache-Control': 'no-store',
            },
          }),
        } as MethodFn.Response<Transport.Http>
    }

    // Try to extract a Payment credential to decide whether to dispatch or challenge.
    // Only gate on the Payment scheme — other auth schemes (Bearer, Basic, etc.)
    // should fall through to the merged-402 path so all offers are presented.
    const header = input.headers.get('Authorization')
    const paymentHeader = header ? Credential.extractPaymentScheme(header) : null

    if (paymentHeader) {
      // Parse the credential to find method+intent for dispatch.
      let credential: Credential.Credential | undefined
      try {
        credential = Credential.deserialize(paymentHeader)
      } catch {}

      if (credential) {
        const { method: credMethod, intent: credIntent } = credential.challenge
        const credReq = credential.challenge.request as Record<string, unknown>

        // Filter by name+intent, then narrow by comparing stable request fields
        // from the echoed challenge against each handler's canonical request.
        // Uses the schema-parsed canonical form (not raw options) so that
        // transformed fields (e.g. amount with decimals) match correctly.
        // Also checks inside methodDetails for fields moved there by transforms.
        const candidates = handlers.filter((h) => {
          const meta = (h as ConfiguredHandler)._internal
          if (!meta || meta.name !== credMethod || meta.intent !== credIntent) return false
          const canonical = meta._canonicalRequest
          if (!canonical) return true
          return !getPinnedRequestBindingMismatch(canonical, credReq)
        })

        const match =
          candidates[0] ??
          handlers.find((h) => {
            const meta = (h as ConfiguredHandler)._internal
            return meta?.name === credMethod && meta?.intent === credIntent
          })
        if (match) return match(input)
      }

      // Payment credential present but no matching handler — dispatch to first
      // handler which will reject with an appropriate error (invalid challenge, etc.).
      return handlers[0]!(input)
    }

    // No credential — call all handlers and merge 402 challenges.
    const results = await Promise.all(handlers.map((h) => h(input)))

    const challengeEntries = (() => {
      const entries: {
        handler: ConfiguredHandler
        challenge: Challenge.Challenge
        result: Extract<MethodFn.Response<Transport.Http>, { status: 402 }>
      }[] = []

      for (let i = 0; i < handlers.length; i++) {
        const result = results[i]
        if (result?.status !== 402) continue

        const response = result.challenge as Response
        const wwwAuth = response.headers.get('WWW-Authenticate')
        if (!wwwAuth) continue

        entries.push({
          handler: handlers[i] as ConfiguredHandler,
          challenge: Challenge.deserialize(wwwAuth),
          result,
        })
      }

      const acceptPayment = input.headers.get('Accept-Payment')
      if (!acceptPayment) return entries

      try {
        const ranked = AcceptPayment.rank(
          entries.map((entry) => entry.challenge),
          AcceptPayment.parse(acceptPayment),
        )
        if (ranked.length === 0) return entries

        const entriesById = new Map(entries.map((entry) => [entry.challenge.id, entry] as const))
        return ranked.map((challenge) => entriesById.get(challenge.id)!)
      } catch {
        return entries
      }
    })()

    // Merge WWW-Authenticate headers from all 402 responses.
    const mergedHeaders = new Headers()
    mergedHeaders.set('Cache-Control', 'no-store')

    for (const entry of challengeEntries) {
      const response = entry.result.challenge as Response
      const wwwAuth = response.headers.get('WWW-Authenticate')
      if (wwwAuth) mergedHeaders.append('WWW-Authenticate', wwwAuth)
    }

    // Collect html-enabled handlers and their challenges
    const htmlEntries = challengeEntries.filter((entry) => entry.handler._internal?.html)

    const wantsHtml = input.headers.get('Accept')?.includes('text/html')
    if (wantsHtml && htmlEntries.length > 0) {
      const { theme, text } = Html.resolveOptions(
        // Use compose-level options or first html-enabled method's config for the page shell
        composeOptions ?? htmlEntries[0]?.handler._internal.html ?? ({} as Html.Options),
      )

      // Build data map keyed by challenge.id
      const dataMap: Record<string, Html.Data> = {}
      for (let i = 0; i < htmlEntries.length; i++) {
        const entry = htmlEntries[i]!
        dataMap[entry.challenge.id] = {
          label: entry.handler._internal.name,
          rootId: `${Html.ids.root}-${i}`,
          formattedAmount: await entry.handler._internal.html!.formatAmount(
            entry.challenge.request,
          ),
          config: entry.handler._internal.html!.config,
          challenge: entry.challenge as never,
          text,
          theme,
        }
      }

      mergedHeaders.set('Content-Type', 'text/html; charset=utf-8')

      const firstData = Object.values(dataMap)[0]!
      const body = Html.render({
        entries: htmlEntries.map((entry) => ({
          challenge: entry.challenge,
          content: entry.handler._internal.html!.content,
        })),
        dataMap,
        formattedAmount: firstData.formattedAmount,
        panels: true,
        text,
        theme,
      })

      return {
        status: 402,
        challenge: new Response(body, { status: 402, headers: mergedHeaders }),
      }
    }

    // Non-HTML fallback: use first handler's body
    let body: string | null = null
    for (const entry of challengeEntries) {
      if (!body) {
        const response = entry.result.challenge as Response
        const contentType = response.headers.get('Content-Type')
        if (contentType) mergedHeaders.set('Content-Type', contentType)
        body = await response.text()
        break
      }
    }

    return {
      status: 402,
      challenge: new Response(body, { status: 402, headers: mergedHeaders }),
    }
  }
}

/**
 * Wraps a payment handler to create a Node.js HTTP listener.
 *
 * On 402: writes the challenge response and ends the connection.
 * On 200: sets the Payment-Receipt header; caller should write response body.
 *
 * @example
 * ```ts
 * import * as http from 'node:http'
 * import { Mppx } from 'mppx/server'
 *
 * const payment = Mppx.create({ ... })
 *
 * http.createServer(async (req, res) => {
 *   const result = await Mppx.toNodeListener(
 *     payment.charge({
 *       amount: '1', currency: '...', recipient: '0x...',
 *     }),
 *   )(req, res)
 *   if (result.status === 402) return
 *   res.end('OK')
 * })
 * ```
 */
export function toNodeListener(
  handler: (input: globalThis.Request) => Promise<MethodFn.Response<Transport.Http>>,
): (req: IncomingMessage, res: ServerResponse) => Promise<MethodFn.Response<Transport.Http>> {
  return async (req, res) => {
    const result = await handler(Request.fromNodeListener(req, res))

    if (result.status === 402) {
      await NodeListener.sendResponse(res, result.challenge as globalThis.Response)
    } else {
      const wrapped = result.withReceipt(new globalThis.Response()) as globalThis.Response
      res.setHeader('Payment-Receipt', wrapped.headers.get('Payment-Receipt')!)
    }

    return result
  }
}

/**
 * Flattens a methods config tuple, preserving positional types.
 * @internal
 */
type FlattenMethods<methods extends Methods> = methods extends readonly [
  infer head,
  ...infer tail extends Methods,
]
  ? head extends readonly Method.AnyServer[]
    ? readonly [...head, ...FlattenMethods<tail>]
    : head extends Method.AnyServer
      ? readonly [head, ...FlattenMethods<tail>]
      : never
  : readonly []
