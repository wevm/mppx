import type * as http from 'node:http'

import * as Credential from '../Credential.js'
import { generateProxy } from '../discovery/OpenApi.js'
import * as Scope from '../server/internal/scope.js'
import * as Request from '../server/Request.js'
import * as Headers from './internal/Headers.js'
import * as Route from './internal/Route.js'
import * as Service from './Service.js'

/** A paid API proxy that gates upstream services behind the mppx 402 protocol. */
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
 * and requires payment via the mppx 402 protocol for non-free endpoints.
 *
 * @example
 * ```ts
 * import { Proxy, openai } from 'mppx/proxy'
 * import { Mppx, tempo } from 'mppx/server'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * const proxy = Proxy.create({
 *   services: [
 *     openai({
 *       apiKey: 'sk-...',
 *       routes: {
 *         'POST /v1/chat/completions': mppx.charge({ amount: '0.05' }),
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
      const proxy = createFetchProxy(s.baseUrl, { fetch: fetchImpl })
      return [s.id, { service: s, proxy }] as const
    }),
  )

  // Pre-generate static discovery responses once at startup.
  const openApiJson = JSON.stringify(
    generateProxy({
      basePath: config.basePath,
      info: {
        title: config.title ?? 'API Proxy',
        version: config.version ?? '1.0.0',
      },
      routes: buildDiscoveryRoutes(config.services),
      serviceInfo: buildServiceInfo(config),
    }),
  )
  const llmsTxt = Service.toLlmsTxt(config.services, {
    title: config.title,
    description: config.description,
    openApiPath: withBasePath(config.basePath, '/openapi.json'),
  })

  async function handle(request: globalThis.Request): Promise<Response> {
    const url = new URL(request.url)

    const pathname = Route.pathname(url, config.basePath)

    if (!pathname) return new Response('Not Found', { status: 404 })

    if (
      request.method === 'GET' &&
      (pathname === '/openapi.json' || pathname === '/openapi.json/')
    ) {
      return new Response(openApiJson, {
        headers: {
          'Cache-Control': 'public, max-age=300',
          'Content-Type': 'application/json',
        },
      })
    }

    if (request.method === 'GET' && pathname === '/llms.txt')
      return new Response(llmsTxt, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    const parsed = Route.parse(pathname)
    if (!parsed) return new Response('Not Found', { status: 404 })

    const { serviceId, upstreamPath } = parsed
    const entry = services.get(serviceId)
    if (!entry) return new Response('Not Found', { status: 404 })

    const { service, proxy } = entry

    const exactMatch = Route.match(service.routes, request.method, upstreamPath)
    const fallbackBinding =
      !exactMatch && request.method === 'POST' && request.headers.has('authorization')
        ? getPaymentBinding(request)
        : null
    const fallbackMatch =
      !exactMatch && request.method === 'POST' && request.headers.has('authorization')
        ? // Management POSTs (e.g. session close) may target a path whose route
          // is registered for a different HTTP method (e.g. GET). Fall back to
          // path-only matching so the payment handler can process the action.
          // When the credential parses cleanly, also bind on payment method+intent
          // so same-path paid routes can coexist without sharing credentials.
          Route.matchPath(
            service.routes,
            upstreamPath,
            // skip free routes (e.g. `'GET /foo/bar': true`)
            (endpoint) => endpoint !== true && matchesPaymentBinding(endpoint, fallbackBinding),
          )
        : null
    const matched = exactMatch ?? fallbackMatch
    if (!matched) return new Response('Not Found', { status: 404 })

    const endpoint = matched.value as Service.Endpoint
    const ctx: Service.Context = { request, service, upstreamPath }

    if (endpoint === true) return proxyUpstream({ request, service, ctx, proxy })

    const handler = typeof endpoint === 'function' ? endpoint : endpoint.pay
    const scope =
      getConfiguredScope(handler) ??
      deriveRouteScope({
        basePath: config.basePath,
        routeKey: matched.key,
        serviceId,
      })
    const result = await handler(
      getConfiguredScope(handler) ? request : Scope.attach(request, scope),
    )
    if (result.status === 402) return result.challenge

    const managementResponse = (() => {
      try {
        return (result.withReceipt as () => Response)()
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'withReceipt() requires a response argument'
        )
          return null
        throw error
      }
    })()

    if (managementResponse) return managementResponse
    if (fallbackMatch) return new Response('Method Not Allowed', { status: 405 })

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
    /** Free-form categories for root discovery metadata. */
    categories?: string[] | undefined
    /** Short description of the proxy shown in `llms.txt`. */
    description?: string | undefined
    /** Structured documentation links for root discovery metadata. */
    docs?: Service.Docs | undefined
    /** Custom `fetch` implementation. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch | undefined
    /** Services to proxy. Each service is mounted at `/{serviceId}/`. */
    services: Service.Service[]
    /** Human-readable title for the proxy shown in `llms.txt`. */
    title?: string | undefined
    /** Version to include in the generated OpenAPI document. */
    version?: string | undefined
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

/** @internal */
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

function buildDiscoveryRoutes(services: Service.Service[]) {
  return services.flatMap((service) =>
    Object.entries(service.routes).map(([pattern, endpoint]) => {
      const tokens = pattern.trim().split(/\s+/)
      const hasMethod = tokens.length >= 2
      const path = hasMethod ? tokens.slice(1).join(' ') : tokens[0]
      return {
        method: hasMethod ? tokens[0]! : 'GET',
        path: `/${service.id}${path}`,
        payment: endpoint ? Service.paymentOf(endpoint) : null,
      }
    }),
  )
}

function getConfiguredScope(handler: Service.IntentHandler): string | undefined {
  if (!('_internal' in handler)) return undefined
  const internal = handler._internal as { meta?: Record<string, string>; scope?: string }
  return Scope.read(internal.meta) ?? internal.scope
}

function deriveRouteScope(parameters: {
  basePath?: string | undefined
  routeKey: string
  serviceId: string
}): string {
  const { basePath, routeKey, serviceId } = parameters
  const { method, pattern } = Route.parseRouteKey(routeKey)
  return `${method ?? '*'} ${withBasePath(basePath, `/${serviceId}${pattern}`)}`
}

function buildServiceInfo(config: create.Config): { categories?: string[]; docs?: Service.Docs } {
  const categories =
    config.categories ??
    Array.from(new Set(config.services.flatMap((service) => service.categories ?? [])))

  const docs = {
    ...(config.docs ?? {}),
    llms: config.docs?.llms ?? withBasePath(config.basePath, '/llms.txt'),
  }

  return {
    ...(categories.length > 0 ? { categories } : {}),
    docs,
  }
}

function withBasePath(basePath: string | undefined, path: string) {
  if (!basePath) return path
  const normalized = basePath.startsWith('/') ? basePath : `/${basePath}`
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  return `${trimmed}${path}`
}

type PaymentBinding = {
  intent: string
  method: string
}

function getPaymentBinding(request: Request): PaymentBinding | null {
  try {
    const credential = Credential.fromRequest(request)
    return {
      intent: credential.challenge.intent,
      method: credential.challenge.method,
    }
  } catch {
    return null
  }
}

function matchesPaymentBinding(endpoint: unknown, binding: PaymentBinding | null): boolean {
  if (endpoint === true) return false
  if (!binding) return true
  const payment = Service.paymentOf(endpoint as Exclude<Service.Endpoint, true>)
  if (!payment) return true
  return payment.method === binding.method && payment.intent === binding.intent
}

function createFetchProxy(
  target: string | URL,
  options?: { fetch?: typeof globalThis.fetch },
): (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> {
  const localFetch = options?.fetch ?? globalThis.fetch
  const targetUrl = new URL(target)
  if (targetUrl.pathname.endsWith('/')) targetUrl.pathname = targetUrl.pathname.replace(/\/+$/, '')

  return async (input, init) => {
    const request = new globalThis.Request(input, init)
    const url = new URL(request.url)
    const proxyUrl = new URL(url.search, targetUrl)
    if (url.pathname !== '/')
      proxyUrl.pathname =
        proxyUrl.pathname === '/' ? url.pathname : proxyUrl.pathname + url.pathname

    const proxyInit: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers: new globalThis.Headers(request.headers),
      signal: request.signal,
      redirect: request.redirect,
      ...init,
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      proxyInit.body = request.body
      proxyInit.duplex = 'half'
    }
    return localFetch(proxyUrl, proxyInit)
  }
}
