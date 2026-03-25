import type {
  Express,
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from 'express'

import type { GenerateConfig, RouteConfig } from '../discovery/OpenApi.js'
import * as Mppx_core from '../server/Mppx.js'
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
    const request = new Request(`${req.protocol}://${req.hostname}${req.originalUrl}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
    })
    const result = await intent(options)(request)

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

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  path?: string
  routes?: RouteConfig[]
}

const discoveryHeaders = { 'Cache-Control': 'public, max-age=300' }

/**
 * Mounts a `GET /openapi.json` route that serves an OpenAPI discovery document.
 */
export function discovery(
  app: Express,
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
): void {
  const mountPath = config.path ?? '/openapi.json'

  let cached: string | undefined

  app.get(mountPath, async (_req: ExpressRequest, res: ExpressResponse) => {
    if (!cached) {
      const { generate } = await import('../discovery/OpenApi.js')
      const doc = generate(mppx, {
        ...(config.info ? { info: config.info } : {}),
        routes: config.routes ?? [],
        ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
      })
      cached = JSON.stringify(doc)
    }
    res.setHeader('Cache-Control', discoveryHeaders['Cache-Control'])
    res.setHeader('Content-Type', 'application/json')
    res.end(cached)
  })
}
