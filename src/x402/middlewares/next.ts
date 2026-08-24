import type { RouteConfig, RoutesConfig, x402ResourceServer } from '@x402/core/server'
import { NextAdapter, paymentProxyFromHTTPServer, withX402FromHTTPServer } from '@x402/next'
import { type NextRequest, NextResponse } from 'next/server.js'

import * as Negotiator from '../../integrations/x402/Negotiator.js'

type RouteHandler = (request: NextRequest) => Promise<Response> | Response

/** Next.js-specific configuration for MPP compatibility wrappers. */
export type Config = Omit<Negotiator.Config, 'routes' | 'server'>

/**
 * Adds MPP negotiation to the official x402 Next.js route wrapper.
 *
 * The official adapter retains ownership of route execution, cancellation,
 * extensions, and post-handler x402 settlement.
 */
export function withMpp(
  handler: RouteHandler,
  route: RouteConfig,
  server: x402ResourceServer,
  config: Config,
): RouteHandler {
  return createHandler(handler, { '*': route }, server, config)
}

/** Creates a dual-protocol Next.js proxy handler backed by the official x402 proxy. */
export function mppProxy(
  routes: RoutesConfig,
  server: x402ResourceServer,
  config: Config,
): RouteHandler {
  const mpp = Negotiator.create({ ...config, routes, server })
  const x402 = paymentProxyFromHTTPServer(mpp.httpServer, config.paywallConfig, undefined, false)

  return async (request) => {
    const result = await mpp.negotiate(request, createContext(request))
    if (result.status === 'unprotected') return NextResponse.next()
    if (result.status === 'handled') return result.response
    if (result.status === 'paid') return result.withReceipt(NextResponse.next())

    return x402(request)
  }
}

function createHandler(
  handler: RouteHandler,
  routes: RoutesConfig,
  server: x402ResourceServer,
  config: Config,
): RouteHandler {
  const mpp = Negotiator.create({ ...config, routes, server })
  const x402 = withX402FromHTTPServer(
    handler as never,
    mpp.httpServer,
    config.paywallConfig,
    undefined,
    false,
  ) as RouteHandler

  return async (request) => {
    const result = await mpp.negotiate(request, createContext(request))
    if (result.status === 'unprotected') return handler(request)
    if (result.status === 'handled') return result.response
    if (result.status === 'paid') return result.withReceipt(await handler(request))

    return x402(request)
  }
}

function createContext(request: NextRequest) {
  const paymentHeader = Negotiator.getX402Credential(request)
  return {
    adapter: new NextAdapter(request),
    method: request.method,
    path: request.nextUrl.pathname,
    ...(paymentHeader ? { paymentHeader } : {}),
  }
}
