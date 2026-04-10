import { Elysia, type Context } from 'elysia'

import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Mppx_core from '../server/Mppx.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

type ElysiaHook = (context: Context) => Promise<Response | undefined>

export namespace Mppx {
  /**
   * Creates an Elysia-aware payment handler where each intent
   * returns an Elysia `beforeHandle` hook.
   *
   * Use with `.guard()` to scope payment to specific routes,
   * or `.onBeforeHandle()` to apply globally.
   *
   * @example
   * ```ts
   * import { Elysia } from 'elysia'
   * import { Mppx, tempo } from 'mppx/elysia'
   *
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * const app = new Elysia()
   *   .guard(
   *     { beforeHandle: mppx.charge({ amount: '1' }) },
   *     (app) => app.get('/premium', () => ({ data: 'paid content' })),
   *   )
   * ```
   */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, ElysiaHook> {
    return Mppx_internal.wrap(Mppx_core.create(config), payment)
  }
}

/**
 * Elysia `beforeHandle` hook that gates a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided.
 *
 * @example
 * ```ts
 * import { Elysia } from 'elysia'
 * import { Mppx } from 'mppx/server'
 * import { payment } from 'mppx/elysia'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * const app = new Elysia()
 *   .guard(
 *     { beforeHandle: payment(mppx.charge, { amount: '1' }) },
 *     (app) => app.get('/premium', () => ({ data: 'paid content' })),
 *   )
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): ElysiaHook {
  return async ({ request, set }) => {
    const result = await intent(options)(request)
    if (result.status === 402) return result.challenge
    const receipt = result.withReceipt(new Response())
    const header = receipt.headers.get('Payment-Receipt')
    if (header) set.headers['Payment-Receipt'] = header
    const cacheControl = receipt.headers.get('Cache-Control')
    if (cacheControl) set.headers['Cache-Control'] = cacheControl
  }
}

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  path?: string
  routes?: RouteConfig[]
}

const discoveryHeaders = { 'Cache-Control': 'public, max-age=300' }

/**
 * Returns an Elysia plugin that serves an OpenAPI discovery document.
 */
export function discovery(
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
) {
  const mountPath = config.path ?? '/openapi.json'

  const cached = JSON.stringify(
    generate(mppx, {
      ...(config.info ? { info: config.info } : {}),
      routes: config.routes ?? [],
      ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
    }),
  )

  return new Elysia().get(
    mountPath,
    () =>
      new Response(cached, {
        headers: { ...discoveryHeaders, 'Content-Type': 'application/json' },
      }),
  )
}
