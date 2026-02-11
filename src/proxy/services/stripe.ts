import type { Endpoint, EndpointMap, Service } from '../Service.js'
import { from, getOptions } from '../Service.js'

type KnownRoute =
  | 'POST /v1/charges'
  | 'POST /v1/customers'
  | 'GET /v1/customers/:id'
  | 'POST /v1/payment_intents'
  | 'GET /v1/payment_intents/:id'
  | 'POST /v1/subscriptions'
  | 'GET /v1/subscriptions/:id'
  | 'POST /v1/invoices'
  | 'GET /v1/invoices/:id'

type Options = {
  apiKey: string
  baseUrl?: string | undefined
}

export function stripe(config: {
  apiKey: string
  baseUrl?: string | undefined
  routes: Partial<Record<KnownRoute, Endpoint>> & Record<string & {}, Endpoint>
}): Service {
  const base = from('stripe', {
    baseUrl: config.baseUrl ?? 'https://api.stripe.com',
    routes: config.routes as EndpointMap,
  })
  return {
    ...base,
    auth(endpoint) {
      const overrides = getOptions(endpoint) as Options | undefined
      if (overrides?.apiKey) return { type: 'basic', username: overrides.apiKey, password: '' }
      return { type: 'basic', username: config.apiKey, password: '' }
    },
  }
}
