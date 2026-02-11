import type * as http from 'node:http'

import { createFetchProxy } from '@remix-run/fetch-proxy'

import * as Request from '../server/Request.js'
import * as Headers from './internal/Headers.js'
import * as Route from './internal/Route.js'
import type * as Service from './Service.js'

export type Proxy = {
  fetch: (request: Request) => Promise<Response>
  listener: (req: http.IncomingMessage, res: http.ServerResponse) => void
}

export type Config = {
  services: Service.Service[]
  fetch?: typeof globalThis.fetch | undefined
}

export function create(config: Config): Proxy {
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
    const parsed = Route.parse(url)
    if (!parsed) return new Response('Not Found', { status: 404 })

    const { serviceId, upstreamPath } = parsed
    const entry = services.get(serviceId)
    if (!entry) return new Response('Not Found', { status: 404 })

    const { service, proxy } = entry

    const matched = Route.match(service.routes, request.method, upstreamPath)
    if (!matched) return new Response('Not Found', { status: 404 })

    const endpoint = matched.value as Service.Endpoint
    const ctx: Service.Context = { request, service, upstreamPath }

    if (endpoint === true) return proxyUpstream(request, service, ctx, proxy)

    const handler: Service.IntentHandler = typeof endpoint === 'function' ? endpoint : endpoint.pay
    const result = await handler(request)
    if (result.status === 402) return result.challenge

    const auth = service.auth(endpoint)
    const upstreamRes = await proxyUpstream(request, service, ctx, proxy, auth)
    return result.withReceipt(upstreamRes)
  }

  return {
    fetch: handle,
    listener: Request.toNodeListener(handle),
  }
}

async function proxyUpstream(
  request: globalThis.Request,
  service: Service.Service,
  ctx: Service.Context,
  proxy: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
  auth?: Service.Auth,
): Promise<Response> {
  const url = ctx.upstreamPath + new URL(request.url).search
  const headers = Headers.scrub(request.headers)

  let upstreamReq = new globalThis.Request(new URL(url, 'http://localhost'), {
    method: request.method,
    headers,
    signal: request.signal,
  })

  if (auth) upstreamReq = await Headers.applyAuth(upstreamReq, auth)

  if (service.rewriteRequest) upstreamReq = await service.rewriteRequest(upstreamReq, ctx)

  let upstreamRes = await proxy(upstreamReq)

  upstreamRes = Headers.scrubResponse(upstreamRes)

  if (service.rewriteResponse) upstreamRes = await service.rewriteResponse(upstreamRes, ctx)

  return upstreamRes
}
