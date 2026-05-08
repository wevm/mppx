import type { Hono, MiddlewareHandler } from 'hono'

import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Scope from '../server/internal/scope.js'
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
    return Mppx_internal.wrap(Mppx_core.create(config), payment)
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
    const request =
      options.scope === undefined && Scope.read(options.meta) === undefined
        ? Scope.attach(c.req.raw, `${c.req.method.toUpperCase()} ${c.req.routePath || c.req.path}`)
        : c.req.raw
    const result = await intent(options)(request)
    if (result.status === 402) return result.challenge
    const managementResponse = getManagementResponse(result)
    if (managementResponse) return managementResponse
    await next()
    c.res = result.withReceipt(c.res)
  }
}

function getManagementResponse(result: { withReceipt: (response?: Response) => Response }) {
  try {
    return result.withReceipt()
  } catch (error) {
    if (error instanceof Error && error.message === 'withReceipt() requires a response argument') {
      return null
    }
    throw error
  }
}

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  auto?: boolean
  path?: string
  routes?: RouteConfig[]
}

const discoveryHeaders = { 'Cache-Control': 'public, max-age=300' }

/**
 * Mounts a `GET /openapi.json` route that serves an OpenAPI discovery document.
 *
 * When `auto` is true, routes are introspected from Hono's internal `app.routes`
 * array. This is a **best-effort / experimental** convenience — `app.routes` is
 * not part of Hono's stable public API and may change across versions. Prefer
 * passing explicit `routes` for production use.
 */
export function discovery(
  app: Hono<any>,
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
): void {
  const mountPath = config.path ?? '/openapi.json'

  let cached: string | undefined

  app.get(mountPath, (c) => {
    if (!cached) {
      const routes = config.routes ?? (config.auto ? introspectRoutes(app) : [])
      const doc = generate(mppx, {
        ...(config.info ? { info: config.info } : {}),
        routes,
        ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
      })
      cached = JSON.stringify(doc)
    }

    c.header('Cache-Control', discoveryHeaders['Cache-Control'])
    c.header('Content-Type', 'application/json')
    return c.body(cached)
  })
}

function introspectRoutes(app: Hono<any>): RouteConfig[] {
  const routes: RouteConfig[] = []
  const appRoutes = (app as any).routes as
    | { handler: any; method: string; path: string }[]
    | undefined

  if (!appRoutes) return routes

  const seen = new Set<string>()

  for (const route of appRoutes) {
    const internal = (route.handler as { _internal?: Record<string, unknown> } | undefined)
      ?._internal
    if (!internal) continue

    const key = `${route.method}:${route.path}:${internal.name}/${internal.intent}`
    if (seen.has(key)) continue
    seen.add(key)

    routes.push({
      handler: route.handler,
      method: route.method,
      path: route.path,
    })
  }

  return routes
}
