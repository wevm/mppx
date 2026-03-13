import type { Hono, MiddlewareHandler } from 'hono'
import type { GenerateConfig, RouteConfig } from '../discovery/OpenApi.js'
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
    const result = await intent(options)(c.req.raw)
    if (result.status === 402) return result.challenge
    await next()
    c.res = result.withReceipt(c.res)
  }
}

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  routes?: RouteConfig[]
  path?: string
  auto?: boolean
}

/**
 * Mounts a `GET /openapi.json` route that serves an OpenAPI discovery
 * document annotated with `x-service-info` and `x-payment-info`.
 *
 * When `auto` is true (Hono only), routes are introspected from
 * `app.routes` and matched to mppx handlers automatically.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { Mppx, discovery } from 'mppx/hono'
 *
 * const app = new Hono()
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * discovery(app, mppx, { auto: true })
 * ```
 */
export function discovery(
  app: Hono<any>,
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
): void {
  const mountPath = config.path ?? '/openapi.json'

  app.get(mountPath, async (c) => {
    const { generate } = await import('../discovery/OpenApi.js')

    let routes: RouteConfig[]
    if (config.routes) {
      routes = config.routes
    } else if (config.auto) {
      routes = introspectRoutes(app, mppx)
    } else {
      routes = []
    }

    const doc = generate(mppx, {
      ...(config.serviceInfo && { serviceInfo: config.serviceInfo }),
      routes,
    })
    return c.json(doc)
  })
}

/**
 * Walks Hono's `app.routes` and matches them to mppx handlers,
 * building `RouteConfig[]` automatically.
 */
function introspectRoutes(
  app: Hono<any>,
  _mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
): RouteConfig[] {
  const routes: RouteConfig[] = []
  const appRoutes = (app as any).routes as
    | { method: string; path: string; handler: any }[]
    | undefined

  if (!appRoutes) return routes

  const seen = new Set<string>()

  for (const route of appRoutes) {
    const handler = route.handler as { _internal?: { name: string; intent: string } } | undefined
    const internal = handler?._internal
    if (!internal) continue

    const key = `${route.method}:${route.path}:${internal.name}/${internal.intent}`
    if (seen.has(key)) continue
    seen.add(key)

    const canonicalRequest = (internal as any)._canonicalRequest as
      | Record<string, unknown>
      | undefined

    routes.push({
      path: route.path,
      method: route.method.toLowerCase(),
      intent: `${internal.name}/${internal.intent}`,
      options: canonicalRequest ?? {},
    })
  }

  return routes
}
