import * as Service from '../Service.js'

/**
 * Creates an OpenAI service definition.
 *
 * Injects `Authorization: Bearer` header for upstream authentication.
 * Per-endpoint `apiKey` overrides are supported via `options`.
 *
 * @example
 * ```ts
 * openai({
 *   apiKey: 'sk-...',
 *   routes: {
 *     'POST /v1/chat/completions': mppx.charge({ amount: '0.05' }),
 *     'GET /v1/models': true,
 *   },
 * })
 * ```
 */
export function openai(config: openai.Config) {
  return Service.from<openai.Config>('openai', {
    baseUrl: config.baseUrl ?? 'https://api.openai.com',
    categories: ['ai'],
    description: 'Chat completions, embeddings, image generation, and audio transcription.',
    docs: {
      apiReference: 'https://platform.openai.com/docs/api-reference',
      homepage: 'https://platform.openai.com/docs',
      llms: 'https://context7.com/websites/platform_openai/llms.txt',
    },
    rewriteRequest(request, ctx) {
      const apiKey = ctx.apiKey ?? config.apiKey
      request.headers.set('Authorization', `Bearer ${apiKey}`)
      return request
    },
    routes: config.routes,
    title: 'OpenAI',
  })
}

export declare namespace openai {
  export type Config = Service.From<{
    /** OpenAI API key. Used as `Authorization: Bearer` header. */
    apiKey: string
    /** Base URL override. Defaults to `'https://api.openai.com'`. */
    baseUrl?: string | undefined
    /** Route definitions for OpenAI endpoints. */
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
