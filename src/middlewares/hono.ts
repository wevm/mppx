import type { MiddlewareHandler } from 'hono'
import * as Mpay_core from '../server/Mpay.js'
import * as Mpay_internal from './internal/mpay.js'

export * from '../server/Methods.js'

export namespace Mpay {
  /**
   * Creates a Hono-aware payment handler where each intent
   * returns a Hono `MiddlewareHandler`.
   *
   * @example
   * ```ts
   * import { Hono } from 'hono'
   * import { Mpay, tempo } from 'mpay/hono'
   *
   * const app = new Hono()
   * const mpay = Mpay.create({ methods: [tempo.charge()] })
   *
   * app.get('/premium', mpay.charge({ amount: '1' }), (c) =>
   *   c.json({ data: 'paid content' }),
   * )
   * ```
   */
  export function create<const methods extends readonly Mpay_internal.AnyServer[]>(
    config: Mpay_core.create.Config<methods>,
  ): Mpay_internal.Wrap<Mpay_core.Mpay<methods>, MiddlewareHandler> {
    return Mpay_internal.wrap(Mpay_core.create(config), payment)
  }
}

/**
 * Hono middleware that gates a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided,
 * otherwise attaches a `Payment-Receipt` header to the response.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { Mpay } from 'mpay/server'
 * import { payment } from 'mpay/hono'
 *
 * const mpay = Mpay.create({ methods: [tempo.charge()] })
 *
 * const app = new Hono()
 * app.get('/premium', payment(mpay.charge, { amount: '1' }), (c) =>
 *   c.json({ data: 'paid content' }),
 * )
 * ```
 */
export function payment<const intent extends Mpay_internal.AnyIntentFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): MiddlewareHandler {
  return async (c, next) => {
    const result = await intent(options)(c.req.raw)
    if (result.status === 402) return result.challenge
    await next()
    c.res = result.withReceipt(c.res)
  }
}
