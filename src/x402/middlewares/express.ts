import type { RoutesConfig, x402ResourceServer } from '@x402/core/server'
import { ExpressAdapter, paymentMiddlewareFromHTTPServer } from '@x402/express'
import type {
  NextFunction,
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
} from 'express'

import * as Negotiator from '../../integrations/x402/Negotiator.js'
import * as ExpressAdapter_ from '../../middlewares/internal/express.js'

/** Express-specific configuration for {@link mpp}. */
export type Config = Omit<Negotiator.Config, 'routes' | 'server'>

/**
 * Adds MPP negotiation to the official x402 Express middleware.
 *
 * x402 retains ownership of response buffering, handler cancellation, hooks, and
 * post-handler settlement. This wrapper only handles MPP credentials and appends
 * an MPP challenge to unpaid x402 responses.
 *
 * @example
 * ```ts
 * import { mpp } from 'mppx/x402/express'
 *
 * app.use(mpp(routes, resourceServer, {
 *   secretKey: process.env.MPP_SECRET_KEY!,
 * }))
 * ```
 */
export function mpp(
  routes: RoutesConfig,
  server: x402ResourceServer,
  config: Config,
): RequestHandler {
  const mpp = Negotiator.create({ ...config, routes, server })
  const x402 = paymentMiddlewareFromHTTPServer(
    mpp.httpServer,
    config.paywallConfig,
    undefined,
    false,
  )

  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const request = ExpressAdapter_.toRequest(req)
    const paymentHeader = Negotiator.getX402Credential(request)
    const context = {
      adapter: new ExpressAdapter(req),
      method: req.method,
      path: req.path,
      ...(paymentHeader ? { paymentHeader } : {}),
    }

    try {
      const result = await mpp.negotiate(request, context)
      if (result.status === 'unprotected') return next()
      if (result.status === 'handled') return ExpressAdapter_.sendResponse(res, result.response)
      if (result.status === 'paid') {
        ExpressAdapter_.copyHeaders(res, result.withReceipt(new Response()).headers)
        return next()
      }
      return x402(req, res, next)
    } catch (error) {
      return next(error)
    }
  }
}
