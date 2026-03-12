import type * as Method from '../Method.js'
import type { ServiceInfo } from './Discovery.js'

export type RouteConfig = {
  path: string
  method: 'get' | 'post' | 'put' | 'delete'
  intent: string
  options: Record<string, unknown>
  summary?: string
  requestBody?: Record<string, unknown>
}

export type GenerateConfig = {
  serviceInfo?: ServiceInfo | undefined
  routes: RouteConfig[]
}

/**
 * Generates an OpenAPI 3.1.0 discovery document from an mppx instance
 * and route configuration.
 *
 * Reads `mppx.methods` to resolve method names and intents, then
 * annotates each route with `x-payment-info` and a 402 response.
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
  // Also set shorthand intent key when unique
  for (const mi of methods) {
    if (intentCount[mi.intent] === 1) methodsByKey.set(mi.intent, mi)
  }

  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of config.routes) {
    const mi = methodsByKey.get(route.intent)
    if (!mi) continue

    const amount = route.options.amount as string | null | undefined
    const currency = route.options.currency as string | undefined

    const paymentInfo: Record<string, unknown> = {
      intent: mi.intent,
      method: mi.name,
      amount: amount ?? null,
    }
    if (currency) paymentInfo.currency = currency

    const operation: Record<string, unknown> = {
      'x-payment-info': paymentInfo,
      responses: {
        '402': {
          description: 'Payment Required',
          headers: {
            'WWW-Authenticate': {
              schema: { type: 'string' },
              description: 'Payment challenge',
            },
          },
        },
        '200': {
          description: 'Successful response',
        },
      },
    }

    if (route.summary) operation.summary = route.summary
    if (route.requestBody) operation.requestBody = route.requestBody

    if (!paths[route.path]) paths[route.path] = {}
    paths[route.path]![route.method] = operation
  }

  const doc: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: mppx.realm,
      version: '1.0.0',
    },
    paths,
  }

  if (config.serviceInfo) doc['x-service-info'] = config.serviceInfo

  return doc
}
