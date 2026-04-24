import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Mppx_core from '../server/Mppx.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

type RouteHandler = (request: Request) => Promise<Response> | Response

type NextjsHandler = (handler: RouteHandler) => RouteHandler

export namespace Mppx {
  /**
   * Creates a Next.js-aware payment handler where each intent
   * returns a wrapper that accepts a route handler.
   *
   * @example
   * ```ts
   * // app/api/premium/route.ts
   * import { Mppx, tempo } from 'mppx/nextjs'
   *
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * export const GET = mppx.charge({ amount: '1' })(() =>
   *   Response.json({ data: 'paid content' }),
   * )
   * ```
   */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, NextjsHandler> {
    return Mppx_internal.wrap(Mppx_core.create(config), (intent, options) => {
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
 * import { Mppx } from 'mppx/server'
 * import { payment } from 'mppx/nextjs'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * export const GET = payment(mppx.charge, { amount: '1' }, () =>
 *   Response.json({ data: 'paid content' }),
 * )
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
  handler: RouteHandler,
): RouteHandler {
  return async (request) => {
    const result = await intent(options)(request)
    if (result.status === 402) return result.challenge
    if (result.status === 'pending') return result.response as Response
    const response = await handler(request)
    return result.withReceipt(response)
  }
}

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  routes?: RouteConfig[]
}

const discoveryHeaders = { 'Cache-Control': 'public, max-age=300' }

/**
 * Creates a route handler that serves an OpenAPI discovery document.
 */
export function discovery(
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
): RouteHandler {
  const cached = JSON.stringify(
    generate(mppx, {
      ...(config.info ? { info: config.info } : {}),
      routes: config.routes ?? [],
      ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
    }),
  )

  return () =>
    new Response(cached, {
      headers: { ...discoveryHeaders, 'Content-Type': 'application/json' },
    })
}
