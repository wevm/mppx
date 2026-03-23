import { Value } from 'ox'

/** A proxied upstream service with route definitions and optional request/response hooks. */
export type Service = {
  /** Base URL of the upstream service (e.g. `'https://api.openai.com'`). */
  baseUrl: string
  /** Short description of the service. */
  description?: string | undefined
  /** Unique identifier used as the URL prefix (e.g. `'openai'` → `/{id}/...`). */
  id: string
  /** Returns a documentation URL. Called with no argument for the service root, or with a route pattern for per-endpoint docs. */
  docsLlmsUrl?: ((options: { route?: string | undefined }) => string | undefined) | undefined
  /** Hook to modify the upstream request before sending (e.g. inject auth headers). */
  rewriteRequest?: ((req: Request, ctx: Context) => Request | Promise<Request>) | undefined
  /** Hook to modify the upstream response before returning to the client. */
  rewriteResponse?: ((res: Response, ctx: Context) => Response | Promise<Response>) | undefined
  /** Map of route patterns to endpoint handlers. */
  routes: EndpointMap
  /** Human-readable title for the service (e.g. `'OpenAI'`). */
  title?: string | undefined
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
    baseUrl: config.baseUrl,
    description: config.description,
    id,
    docsLlmsUrl: resolveLlmsUrl(config.docsLlmsUrl),
    routes: config.routes,
    title: config.title,
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
    /** Short description of the service. */
    description?: string | undefined
    /** Shorthand: inject custom headers. */
    headers?: Record<string, string> | undefined
    /** Documentation URL for the service. String for a static base URL, or a function receiving an optional endpoint pattern. */
    docsLlmsUrl?:
      | string
      | ((options: { route?: string | undefined }) => string | undefined)
      | undefined
    /** Shorthand: full request mutation function. Takes priority over `bearer`/`headers`. */
    mutate?: ((req: Request) => Request | Promise<Request>) | undefined
    /** Hook to modify the upstream request. Receives typed per-endpoint options via `ctx`. */
    rewriteRequest?:
      | ((req: Request, ctx: Context & Partial<options & {}>) => Request | Promise<Request>)
      | undefined
    /** Map of route patterns to endpoint definitions. */
    routes: EndpointMap
    /** Human-readable title for the service. */
    title?: string | undefined
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
    description: s.description,
    id: s.id,
    docsLlmsUrl: s.docsLlmsUrl?.({}),
    routes: Object.entries(s.routes).map(([pattern, endpoint]) => {
      const tokens = pattern.trim().split(/\s+/)
      const hasMethod = tokens.length >= 2
      const path = hasMethod ? tokens.slice(1).join(' ') : tokens[0]
      return {
        docsLlmsUrl: s.docsLlmsUrl?.({ route: pattern }),
        method: hasMethod ? tokens[0] : undefined,
        path: `/${s.id}${path}`,
        pattern: hasMethod ? `${tokens[0]} /${s.id}${path}` : `/${s.id}${path}`,
        payment: endpoint ? resolvePayment(endpoint) : null,
      }
    }),
    title: s.title,
  }
}

/** Renders an llms.txt markdown string for a list of services. */
export function toLlmsTxt(
  services: Service[],
  options?: { title?: string | undefined; description?: string | undefined },
): string {
  const lines: string[] = [
    `# ${options?.title ?? 'API Proxy'}`,
    '',
    `> ${options?.description ?? 'Paid API proxy powered by [Machine Payments Protocol](https://mpp.tempo.xyz).'}`,
    '',
  ]

  if (services.length === 0) return lines.join('\n')

  lines.push('## Services', '')
  for (const s of services) {
    const label = s.title ?? s.id
    const desc = s.description ? `: ${s.description}` : ''
    lines.push(`- [${label}](/discover/${s.id}.md)${desc}`)
  }
  lines.push('', '[See all service definitions](/discover/all.md)')

  return lines.join('\n')
}

/** Renders a full markdown listing of all services with their routes. */
export function toServicesMarkdown(services: Service[]): string {
  const lines: string[] = ['# Services', '']

  if (services.length === 0) return lines.join('\n')

  for (const s of services) {
    lines.push(`## [${s.title ?? s.id}](/discover/${s.id}.md)`, '')
    if (s.description) lines.push(s.description, '')
    pushRoutes(lines, s)
  }

  return lines.join('\n')
}

/** Renders a markdown string for a single service. */
export function toMarkdown(s: Service): string {
  const docsLlmsUrl = s.docsLlmsUrl?.({})
  const lines: string[] = [`# ${s.title ?? s.id}`, '']
  if (docsLlmsUrl) lines.push(`> Documentation: ${docsLlmsUrl}`, '')
  if (s.description) lines.push(s.description, '')
  pushRoutes(lines, s, '##')
  return lines.join('\n')
}

function pushRoutes(lines: string[], s: Service, heading: '##' | '###' = '###') {
  lines.push(`${heading} Routes`, '')
  const serialized = serialize(s)
  for (const route of serialized.routes) {
    const p = route.payment as Record<string, unknown> | null
    const desc = p?.description ? `: ${p.description}` : ''
    lines.push(`- \`${route.pattern}\`${desc}`)
    if (!p) {
      lines.push('  - Type: free')
    } else {
      lines.push(`  - Type: ${p.intent}`)
      if (p.amount) {
        const perUnit = p.unitType ? `/${p.unitType}` : ''
        if (p.decimals !== undefined) {
          const price = Number(p.amount) / 10 ** Number(p.decimals)
          lines.push(`  - Price: ${price}${perUnit} (${p.amount} units, ${p.decimals} decimals)`)
        } else {
          lines.push(`  - Units: ${p.amount}${perUnit}`)
        }
      }
      if (p.currency) lines.push(`  - Currency: ${p.currency}`)
    }
    if (route.docsLlmsUrl) lines.push(`  - Docs: ${route.docsLlmsUrl}`)
    lines.push('')
  }
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
  const {
    name,
    intent,
    defaults: _,
    schema: _s,
    _canonicalRequest,
    ...rest
  } = handler._internal as Record<string, unknown>
  const amount = (() => {
    if (typeof rest.amount === 'string' && typeof rest.decimals === 'number')
      return String(Value.from(rest.amount, rest.decimals))
    return rest.amount
  })()
  return { intent, method: name, ...rest, ...(amount !== undefined && { amount }) }
}

function resolveLlmsUrl(
  input: string | ((options: { route?: string | undefined }) => string | undefined) | undefined,
): Service['docsLlmsUrl'] {
  if (!input) return undefined
  if (typeof input === 'function') return input
  return ({ route }) => (route ? undefined : input)
}
