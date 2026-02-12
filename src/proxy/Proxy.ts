import type * as http from 'node:http'

import { createFetchProxy } from '@remix-run/fetch-proxy'

import * as Request from '../server/Request.js'
import * as Headers from './internal/Headers.js'
import * as Route from './internal/Route.js'
import * as Service from './Service.js'

/** A paid API proxy that gates upstream services behind the mpay 402 protocol. */
export type Proxy = {
  /** Fetch API handler. Works with Bun, Deno, Next.js, Hono, Elysia, SvelteKit, etc. */
  fetch: (request: Request) => Promise<Response>
  /** Node.js request listener. Works with Express, Fastify, `http.createServer`, etc. */
  listener: (req: http.IncomingMessage, res: http.ServerResponse) => void
}

/**
 * Creates a paid API proxy.
 *
 * Routes incoming requests to upstream services, injects credentials,
 * and requires payment via the mpay 402 protocol for non-free endpoints.
 *
 * @example
 * ```ts
 * import { Proxy, openai } from 'mpay/proxy'
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const mpay = Mpay.create({ methods: [tempo()] })
 *
 * const proxy = Proxy.create({
 *   services: [
 *     openai({
 *       apiKey: 'sk-...',
 *       routes: {
 *         'POST /v1/chat/completions': mpay.charge({ amount: '0.05' }),
 *         'GET /v1/models': true,
 *       },
 *     }),
 *   ],
 * })
 * ```
 */
export function create(config: create.Config): Proxy {
  const fetchImpl = config.fetch ?? globalThis.fetch

  const services = new Map(
    config.services.map((s) => {
      const proxy = createFetchProxy(s.baseUrl, {
        fetch: fetchImpl,
        rewriteCookieDomain: false,
        rewriteCookiePath: false,
      })
      return [s.id, { service: s, proxy }] as const
    }),
  )

  async function handle(request: globalThis.Request): Promise<Response> {
    const url = new URL(request.url)
    const parsed = Route.parse(url, config.basePath)
    if (!parsed) return new Response('Not Found', { status: 404 })

    const { serviceId, upstreamPath } = parsed
    const entry = services.get(serviceId)
    if (!entry) return new Response('Not Found', { status: 404 })

    const { service, proxy } = entry

    const matched =
      Route.match(service.routes, request.method, upstreamPath) ??
      // Management POSTs (e.g. session close) may target a path whose route
      // is registered for a different HTTP method (e.g. GET). Fall back to
      // path-only matching so the payment handler can process the action.
      (request.method === 'POST' && request.headers.has('authorization')
        ? Route.matchPath(service.routes, upstreamPath)
        : null)
    if (!matched) return new Response('Not Found', { status: 404 })

    const endpoint = matched.value as Service.Endpoint
    const ctx: Service.Context = { request, service, upstreamPath }

    if (endpoint === true) return proxyUpstream({ request, service, ctx, proxy })

    const handler: Service.IntentHandler = typeof endpoint === 'function' ? endpoint : endpoint.pay
    const result = await handler(request)
    if (result.status === 402) return result.challenge

    const options = Service.getOptions(endpoint)
    const upstreamRes = await proxyUpstream({
      request,
      service,
      ctx: { ...ctx, ...options },
      proxy,
    })
    return result.withReceipt(upstreamRes)
  }

  return {
    fetch: handle,
    listener: Request.toNodeListener(handle),
  }
}

export declare namespace create {
  export type Config = {
    /** Base path prefix to strip before routing (e.g. `'/api/proxy'`). */
    basePath?: string | undefined
    /** Custom `fetch` implementation. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch | undefined
    /** Services to proxy. Each service is mounted at `/{serviceId}/`. */
    services: Service.Service[]
  }
}

declare namespace proxyUpstream {
  type Options = {
    ctx: Service.Context
    proxy: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>
    request: globalThis.Request
    service: Service.Service
  }
}

async function proxyUpstream(options: proxyUpstream.Options): Promise<Response> {
  const { request, service, ctx, proxy } = options
  const url = ctx.upstreamPath + new URL(request.url).search
  const headers = Headers.scrub(request.headers)

  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
  }

  if (hasBody && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }

  let upstreamReq = new globalThis.Request(new URL(url, new URL(service.baseUrl).origin), init)

  if (service.rewriteRequest) upstreamReq = await service.rewriteRequest(upstreamReq, ctx)

  let upstreamRes = await proxy(upstreamReq)

  upstreamRes = Headers.scrubResponse(upstreamRes)

  if (service.rewriteResponse) upstreamRes = await service.rewriteResponse(upstreamRes, ctx)

  return upstreamRes
}
