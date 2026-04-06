import type { IncomingMessage, ServerResponse } from 'node:http'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import * as Expires from '../Expires.js'
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
  Handlers<FlattenMethods<methods>, transport>

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
      challenge: mi.challenge as never,
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
    compose: composeFn,
    realm: realm as string | undefined,
    transport,
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
        const capturedRequest = await transport.captureRequest(input)

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

        // Derive the canonical request used for challenge issuance and binding.
        const challengeRequest = (
          parameters.challenge
            ? await parameters.challenge({ capturedRequest, request: merged } as never)
            : merged
        ) as never

        // Resolve realm: explicit > env var > request Host header.
        const effectiveRealm = realm ?? resolveRealmFromCapturedRequest(capturedRequest)

        // Recompute challenge from options. The HMAC-bound ID means we don't need to
        // store challenges server-side—if the client echoes back a credential with
        // a matching ID, we know it was issued by us with these exact parameters.
        const digest = capturedRequest.bodyDigest
        const challenge = Challenge.fromMethod(method, {
          description,
          digest,
          expires,
          meta,
          realm: effectiveRealm,
          request: challengeRequest,
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

        // Verify the echoed challenge was issued by us by recomputing its HMAC.
        // This is stateless—no database lookup needed.
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

        // Verify the credential's challenge matches this route's stable scope:
        // method, intent, realm, full canonical request, and opaque. This prevents
        // cross-route scope confusion where a credential issued for one route
        // (or different method/intent/opaque) is presented at another.
        // Fields not compared: expires (per-issuance freshness, checked separately),
        // digest (request-body binding, verified separately below), description
        // (intentionally not part of binding).
        {
          const mismatch = getChallengeScopeMismatch(challenge, credential.challenge)
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

        // Verify the echoed digest matches the current request body.
        // The digest is already HMAC-bound via the challenge ID, so tampering
        // with the digest field is caught by the HMAC check above. This check
        // ensures the credential was issued for this specific request body.
        if (credential.challenge.digest && capturedRequest.bodyDigest) {
          if (credential.challenge.digest !== capturedRequest.bodyDigest) {
            const response = await transport.respondChallenge({
              challenge,
              input,
              error: new Errors.InvalidChallengeError({
                id: credential.challenge.id,
                reason: 'request body does not match challenge digest',
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

        const context = {
          coreBinding: getCoreBinding(credential.challenge.request as Record<string, unknown>),
          envelope: {
            capturedRequest,
            challenge: credential.challenge,
            credential,
          },
          methodBinding: getMethodBinding(credential.challenge.request as Record<string, unknown>),
        } satisfies Method.VerifiedPaymentContext

        const request = (
          parameters.request
            ? await parameters.request({ ...context, requestInput: merged } as never)
            : credential.challenge.request
        ) as never

        // User-provided verification (e.g., check signature, submit tx, verify payment).
        // If verification fails, re-issue the challenge so the client can retry.
        let receiptData: Receipt.Receipt
        try {
          receiptData = await verify({ ...context, request } as never)
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
        const respondContext = { ...context, receipt: receiptData, request } as never
        const managementResponse = respond ? await respond(respondContext) : undefined

        return {
          status: 200,
          withReceipt<response>(response?: response) {
            if (managementResponse) {
              return transport.respondReceipt({
                context: respondContext,
                input,
                response: managementResponse as never,
              }) as response
            }
            if (!response) throw new Error('withReceipt() requires a response argument')
            return transport.respondReceipt({
              context: respondContext,
              input,
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
          _canonicalOpaque: options.meta,
        },
      },
    )
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
    challenge?: Method.ChallengeFn<method>
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
    if (/^https?:$/.test(protocol) && hostname) return hostname.toLowerCase()
  } catch {}
  warnOnce(
    Warnings.realmFallback,
    `Could not auto-detect realm from request. Falling back to "${defaultRealm}". Set \`realm\` in Mppx.create() or the MPP_REALM env var.`,
  )
  return defaultRealm
}

type ChallengeScopeField = 'method' | 'intent' | 'realm' | 'request' | 'opaque'

function getChallengeScopeMismatch(
  expected: Challenge.Challenge,
  actual: Challenge.Challenge,
): ChallengeScopeField | undefined {
  if (actual.method !== expected.method) return 'method'
  if (actual.intent !== expected.intent) return 'intent'
  if (actual.realm !== expected.realm) return 'realm'
  if (PaymentRequest.serialize(actual.request) !== PaymentRequest.serialize(expected.request))
    return 'request'
  const expectedOpaque = expected.opaque ? PaymentRequest.serialize(expected.opaque) : ''
  const actualOpaque = actual.opaque ? PaymentRequest.serialize(actual.opaque) : ''
  if (actualOpaque !== expectedOpaque) return 'opaque'
  return undefined
}

type MethodBindingField = 'chainId' | 'memo' | 'splits'
type MethodBinding = Partial<Record<MethodBindingField, unknown>>

function getRequestBinding(request: Record<string, unknown>) {
  const methodDetails = (request.methodDetails ?? {}) as Record<string, unknown>

  return {
    amount: request.amount ?? methodDetails.amount,
    currency: request.currency ?? methodDetails.currency,
    recipient: request.recipient ?? methodDetails.recipient,
    chainId: request.chainId ?? methodDetails.chainId,
    memo: methodDetails.memo,
    splits: methodDetails.splits,
  }
}

function getCoreBinding(request: Record<string, unknown>): Method.CoreBinding {
  const binding = getRequestBinding(request)
  return {
    amount: normalizeScalar(binding.amount),
    currency: normalizeScalar(binding.currency),
    recipient: normalizeScalar(binding.recipient),
  }
}

function getMethodBinding(request: Record<string, unknown>): MethodBinding {
  const binding = getRequestBinding(request)
  return {
    chainId: binding.chainId,
    memo: binding.memo,
    splits: binding.splits,
  }
}

function normalizeScalar(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value)
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
    _canonicalOpaque: Record<string, string> | undefined
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

        // Filter by name+intent, then narrow by comparing the full canonical
        // request and opaque from the echoed challenge against each handler's
        // stored canonical values. This is a best-effort dispatch heuristic —
        // the authoritative scope check happens inside each handler via
        // getChallengeScopeMismatch().
        const candidates = handlers.filter((h) => {
          const meta = (h as ConfiguredHandler)._internal
          if (!meta || meta.name !== credMethod || meta.intent !== credIntent) return false
          const canonical = meta._canonicalRequest
          if (!canonical) return true
          if (
            PaymentRequest.serialize(canonical) !==
            PaymentRequest.serialize(credential.challenge.request)
          )
            return false
          const canonicalOpaque = meta._canonicalOpaque
            ? PaymentRequest.serialize(meta._canonicalOpaque)
            : ''
          const credOpaque = credential.challenge.opaque
            ? PaymentRequest.serialize(credential.challenge.opaque)
            : ''
          return canonicalOpaque === credOpaque
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

    // Merge WWW-Authenticate headers from all 402 responses.
    const mergedHeaders = new Headers()
    mergedHeaders.set('Cache-Control', 'no-store')

    for (const result of results) {
      if (result.status !== 402) continue
      const response = result.challenge as Response
      const wwwAuth = response.headers.get('WWW-Authenticate')
      if (wwwAuth) mergedHeaders.append('WWW-Authenticate', wwwAuth)
    }

    // Collect html-enabled handlers and their challenges
    const htmlEntries = (() => {
      const entries: {
        handler: ConfiguredHandler
        challenge: Challenge.Challenge
      }[] = []
      for (let i = 0; i < handlers.length; i++) {
        const meta = (handlers[i] as ConfiguredHandler)._internal
        if (!meta?.html) continue
        const result = results[i]
        if (result?.status !== 402) continue
        const wwwAuth = result.challenge.headers.get('WWW-Authenticate')
        if (!wwwAuth) continue
        entries.push({
          handler: handlers[i] as ConfiguredHandler,
          challenge: Challenge.deserialize(wwwAuth),
        })
      }
      return entries
    })()

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
    for (const result of results) {
      if (result.status !== 402) continue
      if (!body) {
        const response = result.challenge as Response
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
