import type * as Method from '../Method.js'
import * as PaymentRequest from '../PaymentRequest.js'
import { PaymentInfo, type ServiceInfo } from './Discovery.js'
import * as Metadata from './internal/Metadata.js'

/** Payment handler carrying metadata used to generate discovery documents. */
export type DiscoveryHandler = ((...args: any[]) => unknown) & {
  _internal?: Metadata.Metadata
}

export type LegacyRouteConfig = {
  intent: string
  method: string
  options: Record<string, unknown>
  path: string
  requestBody?: Record<string, unknown>
  summary?: string
}

export type HandlerRouteConfig = {
  handler: DiscoveryHandler
  method: string
  path: string
  requestBody?: Record<string, unknown>
  summary?: string
}

export type RouteConfig = HandlerRouteConfig | LegacyRouteConfig

export type GenerateConfig = {
  info?: { title?: string; version?: string } | undefined
  routes: RouteConfig[]
  serviceInfo?: ServiceInfo | undefined
}

export type GenerateProxyConfig = {
  basePath?: string | undefined
  info?: { title?: string; version?: string } | undefined
  routes: Array<{
    method: string
    path: string
    payment: Record<string, unknown> | null
    requestBody?: Record<string, unknown>
    summary?: string
  }>
  serviceInfo?: ServiceInfo | undefined
}

type ResolvedRoute = {
  method: string
  path: string
  payment: Record<string, unknown> | null
  requestBody?: Record<string, unknown>
  summary?: string
}

/**
 * Generates an OpenAPI 3.1.0 discovery document from an mppx instance
 * and route configuration.
 */
export function generate(
  mppx: { methods: readonly Method.AnyServer[]; realm: string },
  config: GenerateConfig,
): Record<string, unknown> {
  const methods = mppx.methods
  const methodsByKey = new Map<string, Method.AnyServer>()
  const intentCount: Record<string, number> = {}

  for (const mi of methods) {
    methodsByKey.set(`${mi.name}/${mi.intent}`, mi)
    intentCount[mi.intent] = (intentCount[mi.intent] ?? 0) + 1
  }
  for (const mi of methods) {
    if (intentCount[mi.intent] === 1) methodsByKey.set(mi.intent, mi)
  }

  const routes = config.routes.map((route) => resolveRoute(route, methodsByKey))
  return createDocument({
    info: {
      title: config.info?.title ?? mppx.realm,
      version: config.info?.version ?? '1.0.0',
    },
    routes,
    serviceInfo: config.serviceInfo,
  })
}

/**
 * Generates an OpenAPI 3.1.0 discovery document for a proxy surface.
 */
export function generateProxy(config: GenerateProxyConfig): Record<string, unknown> {
  const routes = config.routes.map((route) => ({
    ...route,
    path: withBasePath(config.basePath, route.path),
  }))

  return createDocument({
    info: {
      title: config.info?.title ?? 'API Proxy',
      version: config.info?.version ?? '1.0.0',
    },
    routes,
    serviceInfo: config.serviceInfo,
  })
}

function createDocument(config: {
  info: { title: string; version: string }
  routes: ResolvedRoute[]
  serviceInfo?: ServiceInfo | undefined
}) {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of config.routes) {
    const method = route.method.toLowerCase()
    const operation: Record<string, unknown> = {
      responses: {
        ...(route.payment ? { '402': { description: 'Payment Required' } } : {}),
        '200': { description: 'Successful response' },
      },
    }

    if (route.payment) operation['x-payment-info'] = PaymentInfo.parse(route.payment)
    if (route.summary) operation.summary = route.summary
    if (route.requestBody) operation.requestBody = route.requestBody

    if (!paths[route.path]) paths[route.path] = {}
    paths[route.path]![method] = operation
  }

  const doc: Record<string, unknown> = {
    info: config.info,
    openapi: '3.1.0',
    paths,
  }
  if (config.serviceInfo) doc['x-service-info'] = config.serviceInfo
  return doc
}

function resolveRoute(
  route: RouteConfig,
  methodsByKey: Map<string, Method.AnyServer>,
): ResolvedRoute {
  if ('handler' in route) {
    const internal = route.handler._internal
    if (!internal)
      throw new Error(
        `Route ${route.method.toUpperCase()} ${route.path} is missing discovery metadata`,
      )
    return {
      method: route.method,
      path: route.path,
      payment: {
        offers: Metadata.offers(internal).map(Metadata.paymentOffer),
      },
      ...(route.requestBody ? { requestBody: route.requestBody } : {}),
      ...(route.summary ? { summary: route.summary } : {}),
    }
  }

  const mi = methodsByKey.get(route.intent)
  if (!mi) {
    throw new Error(
      `Unknown intent "${route.intent}" for route ${route.method.toUpperCase()} ${route.path}. Available: ${[...methodsByKey.keys()].join(', ')}`,
    )
  }

  const { description, ...options } = route.options
  const metadata: Metadata.Offer = {
    _canonicalRequest: PaymentRequest.fromMethod(mi, options as never),
    ...(typeof description === 'string' ? { description } : {}),
    intent: mi.intent,
    name: mi.name,
  }

  return {
    method: route.method,
    path: route.path,
    payment: Metadata.paymentOffer(metadata),
    ...(route.requestBody ? { requestBody: route.requestBody } : {}),
    ...(route.summary ? { summary: route.summary } : {}),
  }
}

function withBasePath(basePath: string | undefined, path: string) {
  if (!basePath) return path
  const normalizedBasePath = basePath.startsWith('/') ? basePath : `/${basePath}`
  const trimmedBasePath = normalizedBasePath.endsWith('/')
    ? normalizedBasePath.slice(0, -1)
    : normalizedBasePath
  return `${trimmedBasePath}${path}`
}
