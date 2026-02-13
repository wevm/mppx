import { Value } from 'ox'

/** A proxied upstream service with route definitions and optional request/response hooks. */
export type Service = {
  /** Unique identifier used as the URL prefix (e.g. `'openai'` → `/{id}/...`). */
  id: string
  /** Base URL of the upstream service (e.g. `'https://api.openai.com'`). */
  baseUrl: string
  /** Map of route patterns to endpoint handlers. */
  routes: EndpointMap
  /** Hook to modify the upstream request before sending (e.g. inject auth headers). */
  rewriteRequest?: ((req: Request, ctx: Context) => Request | Promise<Request>) | undefined
  /** Hook to modify the upstream response before returning to the client. */
  rewriteResponse?: ((res: Response, ctx: Context) => Response | Promise<Response>) | undefined
}

/**
 * An endpoint definition.
 *
 * - `IntentHandler` — payment required, calls the handler to issue a 402 challenge or verify payment.
 * - `{ pay, options }` — payment required with per-endpoint config overrides.
 * - `true` — free passthrough, no payment required, rewriteRequest is applied.
 */
export type Endpoint = IntentHandler | { pay: IntentHandler; options: EndpointOptions } | true

/** Map of `"METHOD /pattern"` keys to endpoint definitions. */
export type EndpointMap<routes extends string = string> = Partial<Record<routes, Endpoint>> &
  Record<string & {}, Endpoint>

/** Per-endpoint configuration overrides (e.g. `{ apiKey: 'sk-...' }`). */
export type EndpointOptions = {
  [key: string]: unknown
}

/** A function that handles the mppx payment flow for a request. */
export type IntentHandler = (input: Request) => Promise<IntentResult>

/** Result of an intent handler — either a 402 challenge or a 200 with receipt attachment. */
export type IntentResult =
  | { challenge: Response; status: 402 }
  | { status: 200; withReceipt: <response>(response: response) => response }

/** Context passed to `rewriteRequest`/`rewriteResponse` hooks, including any per-endpoint options. */
export type Context = {
  request: Request
  service: Service
  upstreamPath: string
} & EndpointOptions

export type From<
  options extends {
    routes: string
  },
> = {
  routes: EndpointMap<options['routes']>
} & Omit<options, 'routes'>

/**
 * Creates a service definition.
 *
 * @example
 * ```ts
 * Service.from('my-api', {
 *   baseUrl: 'https://api.example.com',
 *   bearer: 'sk-...',
 *   routes: {
 *     'POST /v1/generate': mppx.charge({ amount: '0.01' }),
 *     'GET /v1/status': true,
 *   },
 * })
 * ```
 */
export function from<options = unknown>(id: string, config: from.Config<options>): Service {
  const rewriteFromConfig = resolveRewriteRequest(config)
  return {
    id,
    baseUrl: config.baseUrl,
    routes: config.routes,
    rewriteRequest: config.rewriteRequest
      ? rewriteFromConfig
        ? async (req, ctx) => {
            req = await rewriteFromConfig(req, ctx)
            return (config.rewriteRequest as Service['rewriteRequest'])!(req, ctx)
          }
        : (config.rewriteRequest as Service['rewriteRequest'])
      : rewriteFromConfig,
  }
}

export declare namespace from {
  export type Config<options = unknown> = {
    /** Base URL of the upstream service. */
    baseUrl: string
    /** Shorthand: inject `Authorization: Bearer {token}` header. */
    bearer?: string | undefined
    /** Shorthand: inject custom headers. */
    headers?: Record<string, string> | undefined
    /** Shorthand: full request mutation function. Takes priority over `bearer`/`headers`. */
    mutate?: ((req: Request) => Request | Promise<Request>) | undefined
    /** Hook to modify the upstream request. Receives typed per-endpoint options via `ctx`. */
    rewriteRequest?:
      | ((req: Request, ctx: Context & Partial<options & {}>) => Request | Promise<Request>)
      | undefined
    /** Map of route patterns to endpoint definitions. */
    routes: EndpointMap
  }
}

export { from as custom }

function resolveRewriteRequest(
  config: from.Config,
): ((req: Request, ctx: Context) => Request | Promise<Request>) | undefined {
  if (config.mutate) {
    const mutate = config.mutate
    return (req, ctx) => {
      const options = ctx as Partial<from.Config>
      const m = options.mutate ?? mutate
      return m(req)
    }
  }
  if (config.bearer) {
    const bearer = config.bearer
    return (req, ctx) => {
      const options = ctx as Partial<from.Config>
      req.headers.set('Authorization', `Bearer ${options.bearer ?? bearer}`)
      return req
    }
  }
  if (config.headers) {
    const headers = config.headers
    return (req, ctx) => {
      const options = ctx as Partial<from.Config>
      const h = options.headers ?? headers
      for (const [name, value] of Object.entries(h)) req.headers.set(name, value)
      return req
    }
  }
  return undefined
}

/** Serializes a service for discovery responses. */
export function serialize(s: Service) {
  return {
    id: s.id,
    baseUrl: s.baseUrl,
    routes: Object.entries(s.routes).map(([pattern, endpoint]) => {
      const tokens = pattern.trim().split(/\s+/)
      const hasMethod = tokens.length >= 2
      return {
        method: hasMethod ? tokens[0] : undefined,
        path: hasMethod ? tokens.slice(1).join(' ') : tokens[0],
        pattern,
        payment: endpoint ? resolvePayment(endpoint) : null,
      }
    }),
  }
}

/** Renders an llms.txt markdown string for a list of services. */
export function toLlmsTxt(services: Service[]): string {
  const lines: string[] = [
    '# API Proxy',
    '',
    '> Paid API proxy powered by [Machine Payments Protocol](https://mpp.tempo.xyz).',
    '',
    'For machine-readable service data, use `GET /services` (JSON).',
    '',
  ]

  if (services.length === 0) return lines.join('\n')

  lines.push('## Services', '')
  for (const s of services) {
    const serialized = serialize(s)
    const free = serialized.routes.filter((r) => r.payment === null).length
    const paid = serialized.routes.length - free
    const parts = [paid && `${paid} paid`, free && `${free} free`].filter(Boolean).join(', ')
    lines.push(`- [${s.id}](${s.baseUrl}): ${parts}`)
  }

  for (const s of services) {
    const serialized = serialize(s)
    lines.push('', `## ${s.id}`, '')
    for (const route of serialized.routes) {
      if (!route.payment) {
        lines.push(`- \`${route.pattern}\`: Free`)
        continue
      }
      const p = route.payment as Record<string, unknown>
      const parts = [`${p.intent}`]
      if (p.amount) {
        const unit = `${p.amount} units`
        parts.push(p.unitType ? `${unit} per ${p.unitType}` : unit)
      }
      if (p.description) parts.push(`"${p.description}"`)
      const meta = [
        p.currency && `currency: ${p.currency}`,
        p.decimals !== undefined && `decimals: ${p.decimals}`,
      ].filter(Boolean)
      if (meta.length) parts.push(`(${meta.join(', ')})`)
      lines.push(`- \`${route.pattern}\`: ${parts.join(' — ')}`)
    }
  }

  return lines.join('\n')
}

/** Extracts per-endpoint options from an endpoint definition. */
export function getOptions(endpoint: Endpoint): EndpointOptions | undefined {
  if (typeof endpoint === 'object' && endpoint !== null && 'options' in endpoint)
    return endpoint.options
  return undefined
}

function resolvePayment(endpoint: Endpoint): Record<string, unknown> | null {
  if (endpoint === true) return null
  const handler = typeof endpoint === 'function' ? endpoint : endpoint.pay
  if (!('_internal' in handler)) return {}
  const { name, method, defaults, schema, ...rest } = handler._internal as Record<string, unknown>
  const amount = (() => {
    if (typeof rest.amount === 'string' && typeof rest.decimals === 'number')
      return String(Value.from(rest.amount, rest.decimals))
    return rest.amount
  })()
  return { intent: name, method, ...rest, ...(amount !== undefined && { amount }) }
}
