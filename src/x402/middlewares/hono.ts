import type { RoutesConfig, x402ResourceServer } from '@x402/core/server'
import { HonoAdapter, paymentMiddlewareFromHTTPServer } from '@x402/hono'
import type { MiddlewareHandler } from 'hono'

import * as Negotiator from '../../integrations/x402/Negotiator.js'

/** Hono-specific configuration for {@link mpp}. */
export type Config = Omit<Negotiator.Config, 'routes' | 'server'>

/**
 * Adds MPP negotiation to the official x402 Hono middleware.
 *
 * The official adapter retains ownership of Hono response handling, cancellation,
 * extensions, and post-handler x402 settlement.
 */
export function mpp(
  routes: RoutesConfig,
  server: x402ResourceServer,
  config: Config,
): MiddlewareHandler {
  const mpp = Negotiator.create({ ...config, routes, server })
  const x402 = paymentMiddlewareFromHTTPServer(
    mpp.httpServer,
    config.paywallConfig,
    undefined,
    false,
  )

  return async (context, next) => {
    const request = context.req.raw
    const paymentHeader = Negotiator.getX402Credential(request)
    const requestContext = {
      adapter: new HonoAdapter(context),
      method: request.method,
      path: new URL(request.url).pathname,
      ...(paymentHeader ? { paymentHeader } : {}),
    }

    const result = await mpp.negotiate(request, requestContext)
    if (result.status === 'unprotected') return next()
    if (result.status === 'handled') {
      context.res = result.response
      return
    }
    if (result.status === 'paid') {
      await next()
      context.res = result.withReceipt(context.res)
      return
    }
    return x402(context, next)
  }
}
