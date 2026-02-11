import * as Service from '../Service.js'

export function openai(config: openai.Config) {
  return Service.from<openai.Config>('openai', {
    baseUrl: config.baseUrl ?? 'https://api.openai.com',
    rewriteRequest(request, ctx) {
      const apiKey = ctx.apiKey ?? config.apiKey
      request.headers.set('Authorization', `Bearer ${apiKey}`)
      return request
    },
    routes: config.routes,
  })
}

export declare namespace openai {
  export type Config = Service.From<{
    apiKey: string
    baseUrl?: string | undefined
    routes:
      | 'POST /v1/chat/completions'
      | 'POST /v1/completions'
      | 'POST /v1/embeddings'
      | 'POST /v1/images/generations'
      | 'POST /v1/images/edits'
      | 'POST /v1/images/variations'
      | 'POST /v1/audio/transcriptions'
      | 'POST /v1/audio/translations'
  }>
}
