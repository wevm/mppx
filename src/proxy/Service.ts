export type Service = {
  id: string
  baseUrl: string
  auth: (endpoint: Endpoint) => Auth
  routes: EndpointMap
  rewriteRequest?: ((req: Request, ctx: Context) => Request | Promise<Request>) | undefined
  rewriteResponse?: ((res: Response, ctx: Context) => Response | Promise<Response>) | undefined
}

export type Auth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string }
  | { type: 'query'; name: string; value: string }
  | { type: 'custom'; apply: (req: Request) => Request | Promise<Request> }

export type Endpoint = IntentHandler | { pay: IntentHandler; options: EndpointOptions } | true

export type EndpointMap = {
  [key: string]: Endpoint
}

export type EndpointOptions = {
  [key: string]: unknown
}

export type IntentHandler = (input: Request) => Promise<IntentResult>

export type IntentResult =
  | { challenge: Response; status: 402 }
  | { status: 200; withReceipt: <response>(response: response) => response }

export type Context = {
  request: Request
  service: Service
  upstreamPath: string
}

export type Options = {
  baseUrl: string
  bearer?: string | undefined
  headers?: Record<string, string> | undefined
  mutate?: ((req: Request) => Request | Promise<Request>) | undefined
  routes: Record<string, Endpoint>
}

export function from(id: string, config: Options): Service {
  return {
    id,
    baseUrl: config.baseUrl,
    auth: (endpoint) => resolveAuth(config, endpoint),
    routes: config.routes,
  }
}

export { from as custom }

function resolveAuth(config: Options, endpoint: Endpoint): Auth {
  const options = getOptions(endpoint) as Partial<Options> | undefined
  const merged = { ...config, ...options }

  if (merged.mutate) return { type: 'custom', apply: merged.mutate }
  if (merged.bearer) return { type: 'bearer', token: merged.bearer }
  if (merged.headers) {
    const entries = Object.entries(merged.headers)
    if (entries.length === 1) {
      const [name, value] = entries[0]!
      return { type: 'header', name, value }
    }
    return {
      type: 'custom',
      apply: (req) => {
        const h = new globalThis.Headers(req.headers)
        for (const [name, value] of entries) h.set(name, value)
        return new globalThis.Request(req.url, {
          method: req.method,
          headers: h,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
          signal: req.signal,
          ...(req.method !== 'GET' && req.method !== 'HEAD' ? { duplex: 'half' as const } : {}),
        })
      },
    }
  }
  return { type: 'custom', apply: (req) => req }
}

export function getOptions(endpoint: Endpoint): Record<string, unknown> | undefined {
  if (typeof endpoint === 'object' && endpoint !== null && 'options' in endpoint)
    return endpoint.options
  return undefined
}
