import * as Service from '../Service.js'

/**
 * Creates a Stripe service definition.
 *
 * Injects `Authorization: Basic` header (API key as username) for upstream authentication.
 * Per-endpoint `apiKey` overrides are supported via `options`.
 *
 * @example
 * ```ts
 * stripe({
 *   apiKey: 'sk-...',
 *   routes: {
 *     'POST /v1/charges': mppx.charge({ amount: '1' }),
 *     'GET /v1/customers/:id': true,
 *   },
 * })
 * ```
 */
export function stripe(config: stripe.Config) {
  return Service.from<stripe.Config>('stripe', {
    baseUrl: config.baseUrl ?? 'https://api.stripe.com',
    description: 'Payment processing, customers, subscriptions, and invoices.',
    docsLlmsUrl: ({ endpoint }) =>
      endpoint
        ? `https://context7.com/websites/stripe/llms.txt?topic=${encodeURIComponent(endpoint)}`
        : 'https://docs.stripe.com/llms.txt',
    rewriteRequest(request, ctx) {
      const apiKey = ctx.apiKey ?? config.apiKey
      request.headers.set('Authorization', `Basic ${btoa(`${apiKey}:`)}`)
      return request
    },
    routes: config.routes,
    title: 'Stripe',
  })
}

export declare namespace stripe {
  export type Config = Service.From<{
    /** Stripe API key. Used as Basic auth username. */
    apiKey: string
    /** Base URL override. Defaults to `'https://api.stripe.com'`. */
    baseUrl?: string | undefined
    routes:
      | 'POST /v1/charges'
      | 'POST /v1/customers'
      | 'GET /v1/customers/:id'
      | 'POST /v1/payment_intents'
      | 'GET /v1/payment_intents/:id'
      | 'POST /v1/subscriptions'
      | 'GET /v1/subscriptions/:id'
      | 'POST /v1/invoices'
      | 'GET /v1/invoices/:id'
  }>
}
