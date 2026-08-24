import type { RouteConfig, RoutesConfig, x402ResourceServer } from '@x402/core/server'
import { NextAdapter, paymentProxyFromHTTPServer, withX402FromHTTPServer } from '@x402/next'
import { type NextRequest, NextResponse } from 'next/server.js'

import * as Negotiator from '../../integrations/x402/Negotiator.js'

type RouteHandler<arguments_ extends unknown[] = []> = (
  request: NextRequest,
  ...arguments_: arguments_
) => Promise<Response> | Response

/** Next.js-specific configuration for MPP compatibility wrappers. */
export type Config = Omit<Negotiator.Config, 'routes' | 'server'>

/**
 * Adds MPP negotiation to the official x402 Next.js route wrapper.
 *
 * The official adapter retains ownership of route execution, cancellation,
 * extensions, and post-handler x402 settlement.
 */
export function mpp<arguments_ extends unknown[]>(
  handler: RouteHandler<arguments_>,
  route: RouteConfig,
  server: x402ResourceServer,
  config: Config,
): RouteHandler<arguments_> {
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

function createHandler<arguments_ extends unknown[]>(
  handler: RouteHandler<arguments_>,
  routes: RoutesConfig,
  server: x402ResourceServer,
  config: Config,
): RouteHandler<arguments_> {
  const mpp = Negotiator.create({ ...config, routes, server })
  const argumentsByRequest = new WeakMap<NextRequest, arguments_>()
  const x402 = withX402FromHTTPServer(
    ((request: NextRequest) => handler(request, ...argumentsByRequest.get(request)!)) as never,
    mpp.httpServer,
    config.paywallConfig,
    undefined,
    false,
  ) as RouteHandler

  return async (request, ...arguments_) => {
    const result = await mpp.negotiate(request, createContext(request))
    if (result.status === 'unprotected') return handler(request, ...arguments_)
    if (result.status === 'handled') return result.response
    if (result.status === 'paid') return result.withReceipt(await handler(request, ...arguments_))

    argumentsByRequest.set(request, arguments_)
    try {
      return await x402(request)
    } finally {
      argumentsByRequest.delete(request)
    }
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
