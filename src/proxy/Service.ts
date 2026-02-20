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

/**
 * Combines multiple intent handlers into one that succeeds if any does.
 *
 * - When no credential is present: runs all handlers, collects their 402 challenges,
 *   and returns a single 402 with multiple `WWW-Authenticate` headers.
 * - When a credential is present: the matching handler will return 200; the combiner
 *   returns that successful result.
 */
export function any(handlers: readonly IntentHandler[]): IntentHandler {
  const combined: IntentHandler = async (input) => {
    // Run all handlers in parallel — they should not consume the request body.
    const results = await Promise.all(
      handlers.map(async (h) => {
        try {
          return await h(input)
        } catch (_e) {
          // Treat thrown errors as 402 with a generic Payment Required challenge placeholder.
          // This is conservative; method handlers typically should not throw.
          const headers = new Headers({
            'Cache-Control': 'no-store',
            // Minimal placeholder to avoid leaking error details; real handler should not throw.
            'WWW-Authenticate':
              'Payment id="error", realm="unknown", method="unknown", intent="unknown", request="e30"',
          })
          return { status: 402 as const, challenge: new Response(null, { status: 402, headers }) }
        }
      }),
    )

    // Prefer any successful verification.
    const success = results.find((r) => r.status === 200)
    if (success) return success

    // Otherwise merge all challenges into a single 402 with multiple WWW-Authenticate headers.
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const r of results) {
      if (r.status === 402) {
        const value = r.challenge.headers.get('WWW-Authenticate')
        if (value) headers.append('WWW-Authenticate', value)
      }
    }
    // Ensure at least one challenge header is present for correctness.
    if (!headers.has('WWW-Authenticate'))
      headers.set(
        'WWW-Authenticate',
        'Payment id="missing", realm="unknown", method="unknown", intent="unknown", request="e30"',
      )

    return { status: 402 as const, challenge: new Response(null, { status: 402, headers }) }
  }

  // Attach internal metadata for discovery: surface that this endpoint offers multiple intents.
  const internals = handlers
    .map((h) =>
      typeof h === 'function' && (h as any)._internal ? (h as any)._internal : undefined,
    )
    .filter(Boolean)
  return Object.assign(combined, internals.length > 0 ? { _internalAny: internals } : {})
}

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
  const routes: Array<{
    docsLlmsUrl?: string | undefined
    method?: string | undefined
    path: string
    pattern: string
    payment: ReadonlyArray<Record<string, unknown>> | null
  }> = []

  for (const [pattern, endpoint] of Object.entries(s.routes)) {
    const tokens = pattern.trim().split(/\s+/)
    const hasMethod = tokens.length >= 2
    const path = hasMethod ? tokens.slice(1).join(' ') : tokens[0]!
    const base = {
      docsLlmsUrl: s.docsLlmsUrl?.({ route: pattern }),
      method: hasMethod ? tokens[0] : undefined,
      path: `/${s.id}${path}`,
      pattern: hasMethod ? `${tokens[0]} /${s.id}${path}` : `/${s.id}${path}`,
    }

    if (!endpoint) continue
    if (endpoint === true) {
      routes.push({ ...base, payment: null })
      continue
    }

    const payments = resolvePayments(endpoint)
    routes.push({ ...base, payment: payments ?? [] })
  }

  return {
    description: s.description,
    id: s.id,
    docsLlmsUrl: s.docsLlmsUrl?.({}),
    routes,
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
    const p = route.payment as ReadonlyArray<Record<string, unknown>> | null
    const first = Array.isArray(p) && p.length > 0 ? (p[0] as any) : null
    const desc = first?.description ? `: ${first.description}` : ''
    lines.push(`- \`${route.pattern}\`${desc}`)
    if (!p) {
      lines.push('  - Type: free')
    } else if (p.length === 0) {
      lines.push('  - Type: paid')
    } else if (p.length === 1) {
      const single = p[0] as any
      lines.push(`  - Type: ${single.intent}`)
      if (single.amount) {
        const perUnit = single.unitType ? `/${single.unitType}` : ''
        if (single.decimals !== undefined) {
          const price = Number(single.amount) / 10 ** Number(single.decimals)
          lines.push(
            `  - Price: ${price}${perUnit} (${single.amount} units, ${single.decimals} decimals)`,
          )
        } else {
          lines.push(`  - Units: ${single.amount}${perUnit}`)
        }
      }
      if (single.currency) lines.push(`  - Currency: ${single.currency}`)
    } else {
      const intents = (p as ReadonlyArray<any>)
        .map((x) => x.intent)
        .filter(Boolean)
        .join(', ')
      lines.push('  - Type: any')
      if (intents) lines.push(`  - Offers: ${intents}`)
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

/** Returns zero, one, or multiple concrete payments for an endpoint. */
function resolvePayments(endpoint: Endpoint): Record<string, unknown>[] | null {
  if (endpoint === true) return null
  const handler = typeof endpoint === 'function' ? endpoint : endpoint.pay
  if ('_internalAny' in (handler as any)) {
    const any = (handler as any)._internalAny as ReadonlyArray<Record<string, unknown>>
    return any.map((m) => {
      const { name, intent, defaults, schema, ...rest } = m
      const amount = (() => {
        if (typeof (rest as any).amount === 'string' && typeof (rest as any).decimals === 'number')
          return String(Value.from((rest as any).amount, (rest as any).decimals))
        return (rest as any).amount
      })()
      return { intent, method: name, ...(rest as object), ...(amount !== undefined && { amount }) }
    })
  }
  if ('_internal' in handler) {
    const { name, intent, defaults, schema, ...rest } = (handler as any)._internal as Record<
      string,
      unknown
    >
    const amount = (() => {
      if (typeof (rest as any).amount === 'string' && typeof (rest as any).decimals === 'number')
        return String(Value.from((rest as any).amount, (rest as any).decimals))
      return (rest as any).amount
    })()
    return [{ intent, method: name, ...(rest as object), ...(amount !== undefined && { amount }) }]
  }
  // Paid but no internal metadata available
  return []
}

function resolveLlmsUrl(
  input: string | ((options: { route?: string | undefined }) => string | undefined) | undefined,
): Service['docsLlmsUrl'] {
  if (!input) return undefined
  if (typeof input === 'function') return input
  return ({ route }) => (route ? undefined : input)
}
