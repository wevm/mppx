import type { Endpoint, EndpointMap, Service } from '../Service.js'
import { from, getOptions } from '../Service.js'

type KnownRoute =
  | 'POST /v1/messages'
  | 'POST /v1/messages/batches'
  | 'GET /v1/messages/batches'
  | 'GET /v1/messages/batches/:batchId'
  | 'POST /v1/complete'

type Options = {
  apiKey: string
  baseUrl?: string | undefined
}

export function anthropic(config: {
  apiKey: string
  baseUrl?: string | undefined
  routes: Partial<Record<KnownRoute, Endpoint>> & Record<string & {}, Endpoint>
}): Service {
  const base = from('anthropic', {
    baseUrl: config.baseUrl ?? 'https://api.anthropic.com',
    headers: { 'x-api-key': config.apiKey },
    routes: config.routes as EndpointMap,
  })
  return {
    ...base,
    auth(endpoint) {
      const overrides = getOptions(endpoint) as Options | undefined
      if (overrides?.apiKey) return { type: 'header', name: 'x-api-key', value: overrides.apiKey }
      return base.auth(endpoint)
    },
  }
}
