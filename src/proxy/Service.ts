export type Service = {
  id: string
  baseUrl: string
  routes: EndpointMap
  rewriteRequest?: ((req: Request, ctx: Context) => Request | Promise<Request>) | undefined
  rewriteResponse?: ((res: Response, ctx: Context) => Response | Promise<Response>) | undefined
}

export type Endpoint = IntentHandler | { pay: IntentHandler; options: EndpointOptions } | true

export type EndpointMap<routes extends string = string> = Partial<Record<routes, Endpoint>> &
  Record<string & {}, Endpoint>

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
} & EndpointOptions

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
    baseUrl: string
    bearer?: string | undefined
    headers?: Record<string, string> | undefined
    mutate?: ((req: Request) => Request | Promise<Request>) | undefined
    rewriteRequest?:
      | ((req: Request, ctx: Context & Partial<options & {}>) => Request | Promise<Request>)
      | undefined
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

export function getOptions(endpoint: Endpoint): EndpointOptions | undefined {
  if (typeof endpoint === 'object' && endpoint !== null && 'options' in endpoint)
    return endpoint.options
  return undefined
}
