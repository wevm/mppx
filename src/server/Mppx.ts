import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDeepStrictEqual } from 'node:util'

import { Json } from 'ox'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import * as Expires from '../Expires.js'
import * as Env from '../internal/env.js'
import type * as Method from '../Method.js'
import * as PaymentRequest from '../PaymentRequest.js'
import type * as Receipt from '../Receipt.js'
import type * as z from '../zod.js'
import { tabScript } from './internal/html/compose.main.gen.js'
import * as Html from './internal/html/config.js'
import { html } from './internal/html/config.js'
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
            ? await parameters.request({ credential, request: merged } as never)
            : merged
        ) as never

        // Resolve realm: explicit > env var > request Host header.
        const effectiveRealm = realm ?? resolveRealmFromRequest(input)

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

        // Verify the credential's challenge matches this route's configured
        // method, intent, realm, and request. Prevents cross-route scope
        // confusion where a credential issued for a cheap route (or different
        // method/intent) is presented at an expensive route.
        // Note: we compare specific payment parameters rather than the full
        // request because the `request` hook may produce credential-dependent
        // output (e.g. `feePayer` differs between 402 and credential calls).
        {
          for (const field of ['method', 'intent', 'realm'] as const) {
            if (credential.challenge[field] !== challenge[field]) {
              const response = await transport.respondChallenge({
                challenge,
                input,
                error: new Errors.InvalidChallengeError({
                  id: credential.challenge.id,
                  reason: `credential ${field} does not match this route's requirements`,
                }),
                html: method.html,
              })
              return { challenge: response, status: 402 }
            }
          }

          const mismatch = getRequestBindingMismatch(
            challenge.request as Record<string, unknown>,
            credential.challenge.request as Record<string, unknown>,
          )
          if (mismatch) {
            const response = await transport.respondChallenge({
              challenge,
              input,
              error: new Errors.InvalidChallengeError({
                id: credential.challenge.id,
                reason: `credential ${mismatch} does not match this route's requirements`,
              }),
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

        // User-provided verification (e.g., check signature, submit tx, verify payment).
        // If verification fails, re-issue the challenge so the client can retry.
        let receiptData: Receipt.Receipt
        try {
          receiptData = await verify({ credential, request } as never)
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
          ? await respond({ credential, input, receipt: receiptData, request } as never)
          : undefined

        return {
          status: 200,
          withReceipt<response>(response?: response) {
            if (managementResponse) {
              return transport.respondReceipt({
                credential,
                input,
                receipt: receiptData,
                response: managementResponse as never,
                challengeId: credential.challenge.id,
              }) as response
            }
            if (!response) throw new Error('withReceipt() requires a response argument')
            return transport.respondReceipt({
              credential,
              input,
              receipt: receiptData,
              response: response as never,
              challengeId: credential.challenge.id,
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

/** Extracts hostname from the request URL, falling back to a default. */
function resolveRealmFromRequest(input: unknown): string {
  try {
    const url = typeof (input as any)?.url === 'string' ? (input as any).url : undefined
    if (url) {
      const { protocol, hostname } = new URL(url)
      if (/^https?:$/.test(protocol) && hostname) return hostname
    }
  } catch {}
  warnOnce(
    Warnings.realmFallback,
    `Could not auto-detect realm from request. Falling back to "${defaultRealm}". Set \`realm\` in Mppx.create() or the MPP_REALM env var.`,
  )
  return defaultRealm
}

type RequestBindingField = 'amount' | 'currency' | 'recipient' | 'chainId' | 'memo' | 'splits'

const requestBindingFields = [
  'amount',
  'currency',
  'recipient',
  'chainId',
  'memo',
  'splits',
] as const satisfies readonly RequestBindingField[]

type RequestBinding = Partial<Record<RequestBindingField, unknown>>

function getRequestBindingMismatch(
  expectedRequest: Record<string, unknown>,
  actualRequest: Record<string, unknown>,
): RequestBindingField | undefined {
  const expected = getRequestBinding(expectedRequest)
  const actual = getRequestBinding(actualRequest)

  return requestBindingFields.find(
    (field) => !requestBindingValuesMatch(field, expected[field], actual[field]),
  )
}

function getRequestBinding(request: Record<string, unknown>): RequestBinding {
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

function requestBindingValuesMatch(
  field: RequestBindingField,
  expected: unknown,
  actual: unknown,
): boolean {
  return isDeepStrictEqual(
    normalizeRequestBindingValue(field, expected),
    normalizeRequestBindingValue(field, actual),
  )
}

function normalizeRequestBindingValue(field: RequestBindingField, value: unknown): unknown {
  switch (field) {
    case 'memo':
      return normalizeHex(value)
    case 'splits':
      return normalizeComparable(value)
    default:
      return normalizeScalar(value)
  }
}

function normalizeScalar(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value)
}

function normalizeHex(value: unknown): unknown {
  return typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value
}

function normalizeComparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeComparable)

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeComparable(nested)]),
    )
  }

  return normalizeHex(value)
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
type ComposeHtmlOptions = { theme?: Html.Theme; text?: Html.Text }

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
    if (new URL(input.url).searchParams.has(Html.serviceWorkerParam)) {
      const hasHtml = handlers.some((h) => (h as ConfiguredHandler)._internal?.html)
      if (hasHtml) {
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
          return !getRequestBindingMismatch(canonical, credReq)
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
      // Use compose-level options or first html-enabled method's config for the page shell
      const shellHtml = composeOptions ?? htmlEntries[0]!.handler._internal.html!
      const theme = Html.mergeDefined(
        {
          favicon: undefined as Html.Theme['favicon'],
          fontUrl: undefined as Html.Theme['fontUrl'],
          logo: undefined as Html.Theme['logo'],
          ...Html.defaultTheme,
        },
        (shellHtml.theme as never) ?? {},
      )
      const text = Html.sanitizeRecord(
        Html.mergeDefined(Html.defaultText, (shellHtml.text as never) ?? {}),
      )

      const firstChallenge = htmlEntries[0]!.challenge

      const hasTabs = htmlEntries.length > 1

      // Build data map keyed by challenge.id (before tabList so we can use formattedAmount)
      const dataMap: Record<string, Html.Data> = {}
      for (let i = 0; i < htmlEntries.length; i++) {
        const entry = htmlEntries[i]!
        dataMap[entry.challenge.id] = {
          label:
            entry.handler._internal.name.charAt(0).toUpperCase() +
            entry.handler._internal.name.slice(1),
          rootId: `${Html.rootId}-${i}`,
          formattedAmount: await entry.handler._internal.html!.formatAmount(
            entry.challenge.request,
          ),
          config: entry.handler._internal.html!.config,
          challenge: entry.challenge as never,
          text,
          theme,
        }
      }

      const firstData = Object.values(dataMap)[0]!
      const dataValues = Object.values(dataMap)

      const tabList = hasTabs
        ? html`<nav class="${Html.classNames.tabList}" role="tablist" aria-label="Payment methods">
            ${dataValues
              .map(
                (data, i) =>
                  html`<button
                    class="${Html.classNames.tab}"
                    role="tab"
                    id="mppx-tab-${i}"
                    aria-selected="${i === 0 ? 'true' : 'false'}"
                    aria-controls="mppx-panel-${i}"
                    ${i !== 0 ? 'tabindex="-1"' : ''}
                    data-amount="${Html.sanitize(data.formattedAmount)}"
                    ${data.challenge.description
                      ? `data-description="${Html.sanitize(data.challenge.description)}"`
                      : ''}
                    ${data.challenge.expires
                      ? `data-expires="${Html.sanitize(data.challenge.expires)}"`
                      : ''}
                    ${data.challenge.expires
                      ? `data-expires-label="${Html.sanitize(text.expires)}"`
                      : ''}
                  >
                    ${Html.sanitize(data.label)}
                  </button>`,
              )
              .join('')}
          </nav>`
        : ''

      const panels = htmlEntries
        .map(
          (_entry, i) =>
            html`<div
              role="${hasTabs ? 'tabpanel' : ''}"
              id="mppx-panel-${i}"
              ${hasTabs ? `aria-labelledby="mppx-tab-${i}"` : ''}
              ${i !== 0 ? 'hidden' : ''}
            >
              <div id="${Html.rootId}-${i}" aria-label="Payment form"></div>
            </div>`,
        )
        .join('')

      mergedHeaders.set('Content-Type', 'text/html; charset=utf-8')

      const body = html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta name="robots" content="noindex" />
            <meta name="color-scheme" content="${theme.colorScheme}" />
            <title>${text.title}</title>
            ${Html.favicon(theme, firstChallenge.realm)} ${Html.font(theme)} ${Html.style(theme)}
            ${hasTabs ? Html.tabStyle() : ''}
          </head>
          <body>
            <main>
              <header class="${Html.classNames.header}">
                ${Html.logo(theme)}
                <span>${text.paymentRequired}</span>
              </header>
              <section class="${Html.classNames.summary}" aria-label="Payment summary">
                <h1 class="${Html.classNames.summaryAmount}">
                  ${Html.sanitize(firstData.formattedAmount)}
                </h1>
                ${firstChallenge.description
                  ? `<p class="${Html.classNames.summaryDescription}">${Html.sanitize(firstChallenge.description)}</p>`
                  : ''}
                ${firstChallenge.expires
                  ? `<p class="${Html.classNames.summaryExpires}">${text.expires} <time datetime="${new Date(firstChallenge.expires).toISOString()}">${new Date(firstChallenge.expires).toLocaleString()}</time></p>`
                  : ''}
              </section>
              ${tabList} ${panels}
              <script
                id="${Html.dataId}"
                type="application/json"
                ${htmlEntries.length > 1 ? ` ${Html.remainingAttr}="${htmlEntries.length}"` : ''}
              >
                ${Json.stringify(dataMap satisfies Record<string, Html.Data>).replace(
                  /</g,
                  '\\u003c',
                )}
              </script>
              ${htmlEntries
                .map((entry) =>
                  entry.handler._internal.html!.content.replace(
                    '<script>',
                    `<script ${Html.challengeIdAttr}="${Html.sanitize(entry.challenge.id)}">`,
                  ),
                )
                .join('\n')}
              ${hasTabs ? tabScript : ''}
            </main>
          </body>
        </html>`

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
