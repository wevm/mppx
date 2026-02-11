import * as Service from '../Service.js'

export function anthropic(config: anthropic.Config) {
  return Service.from<anthropic.Config>('anthropic', {
    baseUrl: config.baseUrl ?? 'https://api.anthropic.com',
    rewriteRequest(request, ctx) {
      const apiKey = ctx.apiKey ?? config.apiKey
      request.headers.set('x-api-key', apiKey)
      return request
    },
    routes: config.routes,
  })
}

export declare namespace anthropic {
  export type Config = Service.From<{
    apiKey: string
    baseUrl?: string | undefined
    routes:
      | 'POST /v1/messages'
      | 'POST /v1/messages/batches'
      | 'GET /v1/messages/batches'
      | 'GET /v1/messages/batches/:batchId'
      | 'POST /v1/complete'
  }>
}
