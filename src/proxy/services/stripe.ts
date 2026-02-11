import * as Service from '../Service.js'

export function stripe(config: stripe.Config) {
  return Service.from<stripe.Config>('stripe', {
    baseUrl: config.baseUrl ?? 'https://api.stripe.com',
    rewriteRequest(request, ctx) {
      const apiKey = ctx.apiKey ?? config.apiKey
      request.headers.set('Authorization', `Basic ${btoa(`${apiKey}:`)}`)
      return request
    },
    routes: config.routes,
  })
}

export declare namespace stripe {
  export type Config = Service.From<{
    apiKey: string
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
