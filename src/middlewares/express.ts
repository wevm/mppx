import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from 'express'
import * as Mppx_core from '../server/Mppx.js'
import * as Request from '../server/Request.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

export namespace Mppx {
  /**
   * Creates an Express-aware payment handler where each intent
   * returns an Express `RequestHandler`.
   *
   * @example
   * ```ts
   * import express from 'express'
   * import { Mppx, tempo } from 'mppx/express'
   *
   * const app = express()
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * app.get('/premium', mppx.charge({ amount: '1' }), (req, res) => {
   *   res.json({ data: 'paid content' })
   * })
   * ```
   */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, RequestHandler> {
    return Mppx_internal.wrap(Mppx_core.create(config), payment)
  }
}

/**
 * Express middleware that gates a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided,
 * otherwise attaches a `Payment-Receipt` header to the response.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { Mppx } from 'mppx/server'
 * import { payment } from 'mppx/express'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * const app = express()
 * app.get('/premium', payment(mppx.charge, { amount: '1' }), (req, res) => {
 *   res.json({ data: 'paid content' })
 * })
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): RequestHandler {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const result = await intent(options)(Request.fromNodeListener(req, res))

    if (result.status === 402) {
      const challenge = result.challenge as Response
      res.status(challenge.status)
      for (const [key, value] of challenge.headers) res.setHeader(key, value)
      res.send(await challenge.text())
      return
    }

    const originalJson = res.json.bind(res)
    res.json = (body: any) => {
      const wrapped = result.withReceipt(Response.json(body))
      res.setHeader('Payment-Receipt', wrapped.headers.get('Payment-Receipt')!)
      return originalJson(body)
    }

    next()
  }
}
