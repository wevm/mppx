import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from 'express'
import * as Mpay_core from '../server/Mpay.js'
import * as Request from '../server/Request.js'
import * as Mpay_internal from './internal/mpay.js'

export * from '../server/Methods.js'

export namespace Mpay {
  /**
   * Creates an Express-aware payment handler where each intent
   * returns an Express `RequestHandler`.
   *
   * @example
   * ```ts
   * import express from 'express'
   * import { Mpay, tempo } from 'mpay/express'
   *
   * const app = express()
   * const mpay = Mpay.create({ methods: [tempo.charge()] })
   *
   * app.get('/premium', mpay.charge({ amount: '1' }), (req, res) => {
   *   res.json({ data: 'paid content' })
   * })
   * ```
   */
  export function create<const methods extends Mpay_core.Methods>(
    config: Mpay_core.create.Config<methods>,
  ): Mpay_internal.Wrap<Mpay_core.Mpay<methods>, RequestHandler> {
    return Mpay_internal.wrap(Mpay_core.create(config), payment)
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
 * import { Mpay } from 'mpay/server'
 * import { payment } from 'mpay/express'
 *
 * const mpay = Mpay.create({ methods: [tempo.charge()] })
 *
 * const app = express()
 * app.get('/premium', payment(mpay.charge, { amount: '1' }), (req, res) => {
 *   res.json({ data: 'paid content' })
 * })
 * ```
 */
export function payment<const intent extends Mpay_internal.AnyIntentFn>(
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
