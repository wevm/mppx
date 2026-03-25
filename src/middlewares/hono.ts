import type { MiddlewareHandler } from 'hono'

import * as Html from '../server/Html.js'
import * as Mppx_core from '../server/Mppx.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

export namespace Mppx {
  /**
   * Creates a Hono-aware payment handler where each intent
   * returns a Hono `MiddlewareHandler`.
   *
   * @example
   * ```ts
   * import { Hono } from 'hono'
   * import { Mppx, tempo } from 'mppx/hono'
   *
   * const app = new Hono()
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * app.get('/premium', mppx.charge({ amount: '1' }), (c) =>
   *   c.json({ data: 'paid content' }),
   * )
   * ```
   */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, MiddlewareHandler> {
    const mppx = Mppx_core.create(config)
    return Mppx_internal.wrap(mppx, (intent, options) => {
      return (async (c, next) => {
        const htmlResponse = await mppx.html(c.req.raw)
        if (htmlResponse) return htmlResponse
        const result = await intent(options)(c.req.raw)
        if (result.status === 402) return result.challenge
        await next()
        c.res = result.withReceipt(c.res)
      }) as MiddlewareHandler
    })
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
 * import { Mppx } from 'mppx/server'
 * import { payment } from 'mppx/hono'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * const app = new Hono()
 * app.get('/premium', payment(mppx.charge, { amount: '1' }), (c) =>
 *   c.json({ data: 'paid content' }),
 * )
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): MiddlewareHandler {
  return async (c, next) => {
    if (new URL(c.req.url).pathname === Html.serviceWorkerPathname)
      return c.body(Html.serviceWorkerScript, {
        headers: { 'Content-Type': 'application/javascript' },
      })
    const result = await intent(options)(c.req.raw)
    if (result.status === 402) return result.challenge
    await next()
    c.res = result.withReceipt(c.res)
  }
}
