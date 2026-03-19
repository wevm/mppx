import * as Service from '../Service.js'

/**
 * Creates a Whop proxy service definition.
 *
 * Proxies requests to the Whop API with authentication.
 * Useful for gating access to Whop API endpoints behind MPP payments.
 *
 * @example
 * ```ts
 * import { whop } from 'mppx/proxy'
 *
 * whop({
 *   apiKey: process.env.WHOP_API_KEY!,
 *   routes: {
 *     'GET /api/v1/products': mppx.charge({ amount: 1 }),
 *     'GET /api/v1/products/:id': true,
 *   },
 * })
 * ```
 */
export function whop(config: whop.Config) {
  return Service.from<whop.Config>('whop', {
    baseUrl: config.baseUrl ?? 'https://api.whop.com',
    description: 'Digital products, memberships, and community access.',
    docsLlmsUrl: 'https://docs.whop.com/llms.txt',
    rewriteRequest(request, ctx) {
      const key = ctx.apiKey ?? config.apiKey
      request.headers.set('Authorization', `Bearer ${key}`)
      return request
    },
    routes: config.routes,
    title: 'Whop',
  })
}

export declare namespace whop {
  export type Config = Service.From<{
    /** Whop API key (Company or App API key). */
    apiKey: string
    /** Base URL override. Defaults to `'https://api.whop.com'`. */
    baseUrl?: string | undefined
    routes:
      | 'GET /api/v1/products'
      | 'GET /api/v1/products/:id'
      | 'GET /api/v1/plans'
      | 'GET /api/v1/plans/:id'
      | 'GET /api/v1/memberships'
      | 'GET /api/v1/memberships/:id'
      | 'POST /api/v1/checkout_configurations'
      | 'GET /api/v1/payments'
      | 'GET /api/v1/payments/:id'
  }>
}
