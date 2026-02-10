import * as Mpay_core from '../server/Mpay.js'
import * as Mpay_internal from './internal/mpay.js'

export * from '../server/Methods.js'

type RouteHandler = (request: Request) => Promise<Response> | Response

type NextjsHandler = (handler: RouteHandler) => RouteHandler

export namespace Mpay {
  /**
   * Creates a Next.js-aware payment handler where each intent
   * returns a wrapper that accepts a route handler.
   *
   * @example
   * ```ts
   * // app/api/premium/route.ts
   * import { Mpay, tempo } from 'mpay/nextjs'
   *
   * const mpay = Mpay.create({ methods: [tempo.charge()] })
   *
   * export const GET = mpay.charge({ amount: '1' })(() =>
   *   Response.json({ data: 'paid content' }),
   * )
   * ```
   */
  export function create<const methods extends readonly Mpay_internal.AnyServer[]>(
    config: Mpay_core.create.Config<methods>,
  ): Mpay_internal.Wrap<Mpay_core.Mpay<methods>, NextjsHandler> {
    return Mpay_internal.wrap(Mpay_core.create(config), (intent, options) => {
      return (handler: RouteHandler) => payment(intent, options, handler)
    })
  }
}

/**
 * Next.js route handler wrapper that gates a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided,
 * otherwise attaches a `Payment-Receipt` header to the response.
 *
 * @example
 * ```ts
 * // app/api/premium/route.ts
 * import { Mpay } from 'mpay/server'
 * import { payment } from 'mpay/nextjs'
 *
 * const mpay = Mpay.create({ methods: [tempo.charge()] })
 *
 * export const GET = payment(mpay.charge, { amount: '1' }, () =>
 *   Response.json({ data: 'paid content' }),
 * )
 * ```
 */
export function payment<const intent extends Mpay_internal.AnyIntentFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
  handler: RouteHandler,
): RouteHandler {
  return async (request) => {
    const result = await intent(options)(request)
    if (result.status === 402) return result.challenge
    const response = await handler(request)
    return result.withReceipt(response)
  }
}
