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
  transport extends Transport.Transport = Transport.Transport,
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
    Method.ContextOf<method>
  >
}

/**
 * Creates a server-side payment handler from a method.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const payment = Mpay.create({
 *   method: tempo({
 *     rpcUrl: 'https://rpc.tempo.xyz',
 *     chainId: 42431,
 *   }),
 *   realm: 'api.example.com',
 *   secretKey: process.env.PAYMENT_SECRET_KEY,
 * })
 * ```
 */
export function create<
  const method extends Method.AnyServer,
  const transport extends Transport.Transport<any, any> = Transport.Transport<Request, Response>,
>(config: create.Config<method, transport>): Mpay<method, transport> {
  const { method, realm, secretKey, transport = Transport.http() as transport } = config
  const { intents, request, verify } = method

  const intentFns: Record<
    string,
    IntentFn<MethodIntent.MethodIntent, transport, Record<string, unknown>>
  > = {}
  for (const [name, intent] of Object.entries(intents as Record<string, MethodIntent.MethodIntent>))
    intentFns[name] = createIntentFn({
      intent,
      realm,
      request: request as never,
      secretKey,
      transport,
      verify: verify as never,
    })

  return { method, realm, transport, ...intentFns } as never
}

export declare namespace create {
  type Config<
    method extends Method.AnyServer = Method.Server,
    transport extends Transport.Transport = Transport.Transport,
  > = {
    /** Payment method (e.g., tempo({ ... })). */
    method: method
    /** Server realm (e.g., hostname). */
    realm: string
    /** Secret key for HMAC-bound challenge IDs (required for stateless verification). */
    secretKey: string
    /** Transport to use (defaults to HTTP). */
    transport?: transport | undefined
  }
}

function createIntentFn<
  intent extends MethodIntent.MethodIntent,
  transport extends Transport.Transport,
  context,
>(
  parameters: createIntentFn.Parameters<intent, transport, context>,
): createIntentFn.ReturnType<intent, transport, context>
// biome-ignore lint/correctness/noUnusedVariables: _
function createIntentFn(parameters: createIntentFn.Parameters): createIntentFn.ReturnType {
  const { intent, realm, secretKey, transport, verify } = parameters

  return (options) =>
    async (input): Promise<IntentFn.Response> => {
      const { description, expires, request: request_, ...context } = options

      // Transform request if method provides a `request` function
      const request = (
        parameters.request ? parameters.request(options as never) : request_
      ) as typeof request_

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
          challenge: transport.respondChallenge(
            challenge,
            input,
            new Errors.MalformedCredentialError({ reason: (e as Error).message }),
          ),
          status: 402,
        }
      }

      // No credential provided—issue challenge
      if (!credential)
        return {
          challenge: transport.respondChallenge(
            challenge,
            input,
            new Errors.PaymentRequiredError({ realm, description }),
          ),
          status: 402,
        }

      // Verify the echoed challenge was issued by us by recomputing its HMAC.
      // This is stateless—no database lookup needed.
      if (!Challenge.verify(credential.challenge, { secretKey }))
        return {
          challenge: transport.respondChallenge(
            challenge,
            input,
            new Errors.InvalidChallengeError({
              id: credential.challenge.id,
              reason: 'challenge was not issued by this server',
            }),
          ),
          status: 402,
        }

      // Validate payload structure against intent schema
      try {
        intent.schema.credential.payload.parse(credential.payload)
      } catch (e) {
        return {
          challenge: transport.respondChallenge(
            challenge,
            input,
            new Errors.InvalidPayloadError({ reason: (e as Error).message }),
          ),
          status: 402,
        }
      }

      // User-provided verification (e.g., check signature, submit tx, verify payment)
      let receiptData: Receipt.Receipt
      try {
        receiptData = await verify({ context, credential, request } as never)
      } catch (e) {
        return {
          challenge: transport.respondChallenge(
            challenge,
            input,
            new Errors.VerificationFailedError({ reason: (e as Error).message }),
          ),
          status: 402,
        }
      }

      return {
        status: 200,
        withReceipt(response) {
          return transport.respondReceipt(receiptData, response, {
            challengeId: credential.challenge.id,
          })
        },
      }
    }
}

declare namespace createIntentFn {
  type Parameters<
    intent extends MethodIntent.MethodIntent = MethodIntent.MethodIntent,
    transport extends Transport.Transport = Transport.Transport,
    context = unknown,
  > = {
    intent: intent
    realm: string
    request?: Method.RequestFn<Record<string, intent>, context>
    secretKey: string
    transport: transport
    verify: Method.VerifyFn<Record<string, intent>, context>
  }

  type ReturnType<
    intent extends MethodIntent.MethodIntent = MethodIntent.MethodIntent,
    transport extends Transport.Transport = Transport.Transport,
    context = unknown,
  > = IntentFn<intent, transport, context>
}

/** @internal */
type IntentFn<
  intent extends MethodIntent.MethodIntent,
  transport extends Transport.Transport,
  context,
> = (
  options: IntentFn.Options<intent, context>,
) => (input: Transport.InputOf<transport>) => Promise<IntentFn.Response<transport>>

/** @internal */
declare namespace IntentFn {
  export type Options<intent extends MethodIntent.MethodIntent, context> = {
    /** Optional human-readable description of the payment. */
    description?: string | undefined
    /** Optional challenge expiration timestamp (ISO 8601). */
    expires?: string | undefined
    /** Payment request parameters. */
    request: z.input<intent['schema']['request']>
  } & ([keyof context] extends [never] ? unknown : context)

  export type Response<transport extends Transport.AnyTransport = Transport.Transport> =
    | { challenge: Transport.OutputOf<transport>; status: 402 }
    | {
        status: 200
        withReceipt: (response: Transport.OutputOf<transport>) => Transport.OutputOf<transport>
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
