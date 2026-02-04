import type { IncomingMessage, ServerResponse } from 'node:http'
import * as Challenge from '../Challenge.js'
import type * as Credential from '../Credential.js'
import * as Errors from '../Errors.js'
import type * as Method from '../Method.js'
import type * as MethodIntent from '../MethodIntent.js'
import type * as Receipt from '../Receipt.js'
import type * as z from '../zod.js'
import * as Request from './Request.js'
import * as Transport from './Transport.js'

/**
 * Payment handler.
 */
export type Mpay<
  method extends Method.AnyServer = Method.Server,
  transport extends Transport.AnyTransport = Transport.Http,
> = {
  /** The payment method. */
  method: method
  /** Server realm (e.g., hostname). */
  realm: string
  /** The transport used. */
  transport: transport
} & {
  [intent in keyof Method.IntentsOf<method>]: IntentFn<
    Method.IntentsOf<method>[intent],
    transport,
    Method.DefaultsOf<method>
  >
}

/**
 * Creates a server-side payment handler from a method.
 *
 * It is highly recommended to set a `secretKey` to bind challenges to their contents,
 * and allow the server to verify that incoming credentials match challenges it issued.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const payment = Mpay.create({
 *   method: tempo(),
 *   secretKey: process.env.PAYMENT_SECRET_KEY,
 * })
 * ```
 */
export function create<
  const method extends Method.AnyServer,
  const transport extends Transport.AnyTransport = Transport.Http,
>(config: create.Config<method, transport>): Mpay<method, transport> {
  const {
    method,
    realm = 'MPP Payment',
    secretKey = 'tmp',
    transport = Transport.http() as transport,
  } = config
  const { defaults, intents, request, verify } = method

  const intentFns: Record<
    string,
    IntentFn<MethodIntent.MethodIntent, transport, Record<string, unknown>>
  > = {}
  for (const [name, intent] of Object.entries(intents as Record<string, MethodIntent.MethodIntent>))
    intentFns[name] = createIntentFn({
      defaults,
      intent,
      realm,
      request: request as never,
      secretKey,
      transport,
      verify: verify as never,
    })

  return { method, realm: realm as string, transport, ...intentFns } as never
}

export declare namespace create {
  type Config<
    method extends Method.AnyServer = Method.Server,
    transport extends Transport.AnyTransport = Transport.Http,
  > = {
    /** Payment method (e.g., tempo()). */
    method: method
    /** Server realm (e.g., hostname). @default "MPP Payment". */
    realm?: string | undefined
    /** Secret key for HMAC-bound challenge IDs for stateless verification. */
    secretKey?: string | undefined
    /** Transport to use. @default Transport.http() */
    transport?: transport | undefined
  }
}

function createIntentFn<
  intent extends MethodIntent.MethodIntent,
  transport extends Transport.AnyTransport,
  defaults extends Record<string, unknown>,
>(
  parameters: createIntentFn.Parameters<intent, transport, defaults>,
): createIntentFn.ReturnType<intent, transport, defaults>
// biome-ignore lint/correctness/noUnusedVariables: _
function createIntentFn(parameters: createIntentFn.Parameters): createIntentFn.ReturnType {
  const { defaults, intent, realm, secretKey, transport, verify } = parameters

  return (options) =>
    async (input): Promise<IntentFn.Response> => {
      const { description, ...rest } = options
      const expires = 'expires' in options ? (options.expires as string | undefined) : undefined

      // Merge defaults with per-request options
      const merged = { ...defaults, ...rest }

      const credential_request = (() => {
        try {
          return transport.getCredential(input) as Credential.Credential | null
        } catch {}
      })()

      // Transform request if method provides a `request` function.
      const request = (
        parameters.request
          ? parameters.request({ credential: credential_request, request: merged } as never)
          : merged
      ) as never

      // Recompute challenge from options. The HMAC-bound ID means we don't need to
      // store challenges server-side—if the client echoes back a credential with
      // a matching ID, we know it was issued by us with these exact parameters.
      const challenge = Challenge.fromIntent(intent, {
        description,
        expires,
        realm,
        request,
        secretKey,
      })

      // Extract credential from transport input
      let credential: Credential.Credential | null
      try {
        credential = transport.getCredential(input) as Credential.Credential | null
      } catch (e) {
        // Credential was provided but malformed
        return {
          challenge: await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.MalformedCredentialError({ reason: (e as Error).message }),
          }),
          status: 402,
        }
      }

      // No credential provided—issue challenge
      if (!credential)
        return {
          challenge: await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.PaymentRequiredError({ realm, description }),
          }),
          status: 402,
        }

      // Verify the echoed challenge was issued by us by recomputing its HMAC.
      // This is stateless—no database lookup needed.
      if (!Challenge.verify(credential.challenge, { secretKey }))
        return {
          challenge: await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.InvalidChallengeError({
              id: credential.challenge.id,
              reason: 'challenge was not issued by this server',
            }),
          }),
          status: 402,
        }

      // Validate payload structure against intent schema
      try {
        intent.schema.credential.payload.parse(credential.payload)
      } catch (e) {
        return {
          challenge: await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.InvalidPayloadError({ reason: (e as Error).message }),
          }),
          status: 402,
        }
      }

      // User-provided verification (e.g., check signature, submit tx, verify payment)
      let receiptData: Receipt.Receipt
      try {
        receiptData = await verify({ credential, request } as never)
      } catch (e) {
        return {
          challenge: await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.VerificationFailedError({ reason: (e as Error).message }),
          }),
          status: 402,
        }
      }

      // Per spec, synchronous flows MUST NOT return 200 with a failed receipt.
      // If payment failed (e.g., tx reverted on-chain), return 402.
      if (receiptData.status === 'failed') {
        return {
          challenge: await transport.respondChallenge({
            challenge,
            input,
            error: new Errors.VerificationFailedError({
              reason: `payment failed: ${receiptData.reference}`,
            }),
          }),
          status: 402,
        }
      }

      return {
        status: 200,
        withReceipt<T>(response: T) {
          return transport.respondReceipt({
            receipt: receiptData,
            response: response as never,
            challengeId: credential.challenge.id,
          }) as T
        },
      }
    }
}

declare namespace createIntentFn {
  type Parameters<
    intent extends MethodIntent.MethodIntent = MethodIntent.MethodIntent,
    transport extends Transport.AnyTransport = Transport.Http,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = {
    defaults?: defaults
    intent: intent
    realm: string
    request?: Method.RequestFn<Record<string, intent>>
    secretKey: string
    transport: transport
    verify: Method.VerifyFn<Record<string, intent>>
  }

  type ReturnType<
    intent extends MethodIntent.MethodIntent = MethodIntent.MethodIntent,
    transport extends Transport.AnyTransport = Transport.Http,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = IntentFn<intent, transport, defaults>
}

/** @internal */
type IntentFn<
  intent extends MethodIntent.MethodIntent,
  transport extends Transport.AnyTransport,
  defaults extends Record<string, unknown>,
> = (
  options: IntentFn.Options<intent, defaults>,
) => (input: Transport.InputOf<transport>) => Promise<IntentFn.Response<transport>>

/** @internal */
declare namespace IntentFn {
  export type Options<
    intent extends MethodIntent.MethodIntent,
    defaults extends Record<string, unknown> = Record<string, unknown>,
  > = {
    /** Optional human-readable description of the payment. */
    description?: string | undefined
    /** Optional challenge expiration timestamp (ISO 8601). */
    expires?: string | undefined
  } & Method.RequestFn.WithDefaults<z.input<intent['schema']['request']>, defaults>

  export type Response<transport extends Transport.AnyTransport = Transport.Http> =
    | { challenge: Transport.ChallengeOutputOf<transport>; status: 402 }
    | {
        status: 200
        withReceipt: <T>(response: T) => T
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
 * import { Mpay } from 'mpay/server'
 *
 * const payment = Mpay.create({ ... })
 *
 * http.createServer(async (req, res) => {
 *   const result = await Mpay.toNodeListener(
 *     payment.charge({
 *       request: { amount: '1000', currency: '...', recipient: '0x...' },
 *     }),
 *   )(req, res)
 *   if (result.status === 402) return
 *   res.end('OK')
 * })
 * ```
 */
export function toNodeListener(
  handler: (input: globalThis.Request) => Promise<IntentFn.Response<Transport.Http>>,
): (req: IncomingMessage, res: ServerResponse) => Promise<IntentFn.Response<Transport.Http>> {
  return async (req, res) => {
    const result = await handler(Request.fromNodeListener(req, res))

    if (result.status === 402) {
      const httpResponse = result.challenge as globalThis.Response
      res.writeHead(402, Object.fromEntries(httpResponse.headers))
      const body = await httpResponse.text()
      if (body) res.write(body)
      res.end()
    } else {
      const wrapped = result.withReceipt(new globalThis.Response()) as globalThis.Response
      res.setHeader('Payment-Receipt', wrapped.headers.get('Payment-Receipt')!)
    }

    return result
  }
}
