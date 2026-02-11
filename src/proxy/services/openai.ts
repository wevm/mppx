import type { Endpoint, EndpointMap, Service } from '../Service.js'
import { from, getOptions } from '../Service.js'

type KnownRoute =
  | 'POST /v1/chat/completions'
  | 'POST /v1/completions'
  | 'POST /v1/embeddings'
  | 'POST /v1/images/generations'
  | 'POST /v1/images/edits'
  | 'POST /v1/images/variations'
  | 'POST /v1/audio/transcriptions'
  | 'POST /v1/audio/translations'
  | 'POST /v1/audio/speech'
  | 'POST /v1/moderations'
  | 'GET /v1/models'
  | 'GET /v1/models/:model'

type Options = {
  apiKey: string
  baseUrl?: string | undefined
}

export function openai(config: {
  apiKey: string
  baseUrl?: string | undefined
  routes: Partial<Record<KnownRoute, Endpoint>> & Record<string & {}, Endpoint>
}): Service {
  const base = from('openai', {
    baseUrl: config.baseUrl ?? 'https://api.openai.com',
    bearer: config.apiKey,
    routes: config.routes as EndpointMap,
  })
  return {
    ...base,
    auth(endpoint) {
      const overrides = getOptions(endpoint) as Options | undefined
      if (overrides?.apiKey) return { type: 'bearer', token: overrides.apiKey }
      return base.auth(endpoint)
    },
  }
}
