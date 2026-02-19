import * as Service from '../Service.js'

/**
 * Creates an Anthropic service definition.
 *
 * Injects `x-api-key` header for upstream authentication.
 * Per-endpoint `apiKey` overrides are supported via `options`.
 *
 * @example
 * ```ts
 * anthropic({
 *   apiKey: 'sk-ant-...',
 *   routes: {
 *     'POST /v1/messages': mppx.charge({ amount: '0.03' }),
 *     'POST /v1/complete': mppx.charge({ amount: '0.02' }),
 *   },
 * })
 * ```
 */
export function anthropic(config: anthropic.Config) {
  return Service.from<anthropic.Config>('anthropic', {
    baseUrl: config.baseUrl ?? 'https://api.anthropic.com',
    description: 'Claude language models for messages and completions.',
    rewriteRequest(request, ctx) {
      const apiKey = ctx.apiKey ?? config.apiKey
      request.headers.set('x-api-key', apiKey)
      return request
    },
    routes: config.routes,
    title: 'Anthropic',
  })
}

export declare namespace anthropic {
  export type Config = Service.From<{
    /** Anthropic API key. Used as `x-api-key` header. */
    apiKey: string
    /** Base URL override. Defaults to `'https://api.anthropic.com'`. */
    baseUrl?: string | undefined
    routes:
      | 'POST /v1/messages'
      | 'POST /v1/messages/batches'
      | 'GET /v1/messages/batches'
      | 'GET /v1/messages/batches/:batchId'
      | 'POST /v1/complete'
  }>
}
