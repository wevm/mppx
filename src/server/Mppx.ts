import type { IncomingMessage, ServerResponse } from 'node:http'
import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import * as Env from '../internal/env.js'
import type * as Method from '../Method.js'
import type * as Receipt from '../Receipt.js'
import type * as z from '../zod.js'
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
  /**
   * Combines multiple method handlers into a single route handler that presents
   * all methods to the client via multiple `WWW-Authenticate` headers.
   *
   * Each entry is a `[method, options]` tuple where `method` is one of the
   * server methods passed to `Mppx.create()`, looked up by `name`+`intent`.
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
  /** Server realm (e.g., hostname). */
  realm: string
  /** The transport used. */
  transport: transport
} & Handlers<FlattenMethods<methods>, transport>

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
type IsUniqueIntent<methods extends readonly Method.AnyServer[], intent extends string> = Extract<
  methods[number],
  { intent: intent }
> extends infer M
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
    >
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
    realm = Env.get('realm') ?? 'MPP Payment',
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
    ;(handlers[mi.name] as Record<string, unknown>)[mi.intent] = handlers[`${mi.name}/${mi.intent}`]
  }

  function composeFn(...entries: readonly [Method.AnyServer | string, Record<string, unknown>][]) {
    if (entries.length === 0) throw new Error('compose() requires at least one entry')
    const configured = entries.map(([methodOrKey, options]) => {
      const key =
        typeof methodOrKey === 'string' ? methodOrKey : `${methodOrKey.name}/${methodOrKey.intent}`
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
    realm: realm as string,
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
    /** Server realm (e.g., hostname). Auto-detected from environment variables (`MPP_REALM`, `VERCEL_URL`, `RAILWAY_PUBLIC_DOMAIN`, `RENDER_EXTERNAL_HOSTNAME`, `HOST`, `HOSTNAME`), falling back to `"localhost"`. */
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
    return Object.assign(
      async (input: Transport.InputOf): Promise<MethodFn.Response> => {
        const { description, meta, ...rest } = options
        const expires = 'expires' in options ? (options.expires as string | undefined) : undefined

        // Merge defaults with per-request options
        const merged = { ...defaults, ...rest }

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

        // Recompute challenge from options. The HMAC-bound ID means we don't need to
        // store challenges server-side—if the client echoes back a credential with
        // a matching ID, we know it was issued by us with these exact parameters.
        const challenge = Challenge.fromMethod(method, {
          description,
          expires,
          meta,
          realm,
          request,
          secretKey,
        })

        // Credential was provided but malformed
        if (credentialError) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.MalformedCredentialError({ reason: credentialError.message }),
          })
          return { challenge: response, status: 402 }
        }

        // No credential provided—issue challenge
        if (!credential) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.PaymentRequiredError({ description }),
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
          })
          return { challenge: response, status: 402 }
        }

        // Verify the credential's challenge matches this route's configured
        // request. Prevents cross-route scope confusion where a credential
        // issued for a cheap route is presented at an expensive route.
        // Note: we compare specific payment parameters rather than the full
        // request because the `request` hook may produce credential-dependent
        // output (e.g. `feePayer` differs between 402 and credential calls).
        {
          const routeReq = challenge.request as Record<string, unknown>
          const echoedReq = credential.challenge.request as Record<string, unknown>
          for (const field of ['amount', 'currency', 'recipient'] as const) {
            if (
              routeReq[field] !== undefined &&
              echoedReq[field] !== undefined &&
              String(routeReq[field]) !== String(echoedReq[field])
            ) {
              const response = await transport.respondChallenge({
                challenge,
                input,
                error: new Errors.InvalidChallengeError({
                  id: credential.challenge.id,
                  reason: `credential ${field} does not match this route's requirements`,
                }),
              })
              return { challenge: response, status: 402 }
            }
          }
        }

        // Reject expired credentials
        if (credential.challenge.expires && new Date(credential.challenge.expires) < new Date()) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.PaymentExpiredError({
              expires: credential.challenge.expires,
            }),
          })
          return { challenge: response, status: 402 }
        }
        // Validate payload structure against method schema
        try {
          method.schema.credential.payload.parse(credential.payload)
        } catch (e) {
          const response = await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.InvalidPayloadError({ reason: (e as Error).message }),
          })
          return { challenge: response, status: 402 }
        }

        // User-provided verification (e.g., check signature, submit tx, verify payment).
        // If verification fails, re-issue the challenge so the client can retry.
        let receiptData: Receipt.Receipt
        try {
          receiptData = await verify({ credential, request } as never)
        } catch (e) {
          const error =
            e instanceof Errors.PaymentError
              ? e
              : new Errors.VerificationFailedError({ reason: (e as Error).message })
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
                receipt: receiptData,
                response: managementResponse as never,
                challengeId: credential.challenge.id,
              }) as response
            }
            if (!response) throw new Error('withReceipt() requires a response argument')
            return transport.respondReceipt({
              receipt: receiptData,
              response: response as never,
              challengeId: credential.challenge.id,
            }) as response
          },
        }
      },
      {
        _internal: { ...method, ...defaults, ...options, name: method.name, intent: method.intent },
      },
    )
  }
}

declare namespace createMethodFn {
  type Parameters<
    method extends Method.Method = Method.Method,
    transport extends Transport.AnyTransport = Transport.Http,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = {
    defaults?: defaults
    method: method
    realm: string
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

export type MethodFn<
  method extends Method.Method,
  transport extends Transport.AnyTransport,
  defaults extends Record<string, unknown>,
> = (
  options: MethodFn.Options<method, defaults>,
) => (input: Transport.InputOf<transport>) => Promise<MethodFn.Response<transport>>
/** @internal */
export type AnyMethodFn = (options: any) => (input: any) => Promise<any>

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
  _internal: { name: string; intent: string }
}

/** An entry for `compose()`: a method reference (or string key) paired with its options. */
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
export function compose(
  ...handlers: readonly ((input: Request) => Promise<MethodFn.Response<Transport.Http>>)[]
): (input: Request) => Promise<MethodFn.Response<Transport.Http>> {
  if (handlers.length === 0) throw new Error('compose() requires at least one handler')

  return async (input: Request) => {
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
        // from the echoed challenge against each handler's configured options.
        // This disambiguates handlers with the same name/intent but different
        // amounts, currencies, recipients, etc. without invoking any handler.
        const candidates = handlers.filter((h) => {
          const meta = (h as ConfiguredHandler)._internal
          if (!meta || meta.name !== credMethod || meta.intent !== credIntent) return false
          // Compare stable fields that don't change between 402 and credential calls.
          for (const field of ['amount', 'currency', 'recipient'] as const) {
            const metaVal = (meta as Record<string, unknown>)[field]
            if (
              metaVal !== undefined &&
              credReq[field] !== undefined &&
              String(metaVal) !== String(credReq[field])
            )
              return false
          }
          return true
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

    let body: string | null = null
    for (const result of results) {
      if (result.status !== 402) continue
      const response = result.challenge as Response
      const wwwAuth = response.headers.get('WWW-Authenticate')
      if (wwwAuth) mergedHeaders.append('WWW-Authenticate', wwwAuth)
      // Use the first handler's body for the problem details response.
      if (!body) {
        const contentType = response.headers.get('Content-Type')
        if (contentType) mergedHeaders.set('Content-Type', contentType)
        body = await response.text()
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
