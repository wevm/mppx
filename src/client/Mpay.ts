import type * as Challenge from '../Challenge.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import * as Transport from './Transport.js'

type AnyClient = Method.Client<any, any, any>

/**
 * Client-side payment handler.
 */
export type Mpay<
  methods extends readonly AnyClient[] = readonly AnyClient[],
  transport extends Transport.Transport = Transport.Transport,
> = {
  /** The configured payment methods. */
  methods: methods
  /** The transport used. */
  transport: transport
  /** Creates a credential from a payment-required response by routing to the correct method. */
  createCredential: (
    response: Transport.ResponseOf<transport>,
    context?: AnyContextFor<methods> | undefined,
  ) => Promise<string>
}

/**
 * Creates a client-side payment handler from an array of methods.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/client'
 *
 * const mpay = Mpay.create({
 *   methods: [tempo.charge()],
 * })
 *
 * const response = await fetch('/resource')
 * if (response.status === 402) {
 *   const credential = await mpay.createCredential(response, {
 *     account: privateKeyToAccount('0x...'),
 *   })
 *   // Retry with credential
 *   await fetch('/resource', {
 *     headers: { Authorization: credential },
 *   })
 * }
 * ```
 */
export function create<
  const methods extends readonly AnyClient[],
  const transport extends Transport.Transport<any, any> = Transport.Transport<
    RequestInit,
    Response
  >,
>(config: create.Config<methods, transport>): Mpay<methods, transport> {
  const { methods, transport = Transport.http() as transport } = config

  return {
    methods,
    transport,
    async createCredential(response: Transport.ResponseOf<transport>, context?: unknown) {
      const challenge = transport.getChallenge(response as never) as Challenge.Challenge

      const method = methods.find((m) => m.name === challenge.method)
      if (!method)
        throw new Error(
          `No method found for "${challenge.method}". Available: ${methods.map((m) => m.name).join(', ')}`,
        )

      const parsedContext =
        method.context && context !== undefined ? method.context.parse(context) : undefined

      return method.createCredential(
        parsedContext !== undefined
          ? { challenge, context: parsedContext }
          : ({ challenge } as never),
      )
    },
  }
}

export declare namespace create {
  type Config<
    methods extends readonly AnyClient[] = readonly AnyClient[],
    transport extends Transport.Transport = Transport.Transport,
  > = {
    /** Array of payment methods to use. */
    methods: methods
    /** Transport to use (defaults to HTTP). */
    transport?: transport | undefined
  }
}

/**
 * Union of all context types from all methods that have context schemas.
 * @internal
 */
type AnyContextFor<methods extends readonly AnyClient[]> = {
  [method in keyof methods]: methods[method] extends Method.Client<any, any, infer context>
    ? context extends z.ZodMiniType
      ? z.input<context>
      : undefined
    : undefined
}[number]
