const httpMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

export function parse(url: URL): { serviceId: string; upstreamPath: string } | null {
  const segments = url.pathname.split('/').filter(Boolean)
  const serviceId = segments[0]
  if (!serviceId) return null

  const upstreamPath = `/${segments.slice(1).join('/')}`
  return { serviceId, upstreamPath }
}

export function match(
  routes: Record<string, unknown>,
  method: string,
  path: string,
): { key: string; value: unknown } | null {
  for (const [key, value] of Object.entries(routes)) {
    const tokens = key.trim().split(/\s+/)

    let routeMethod: string | undefined
    let pattern: string

    if (tokens.length >= 2 && httpMethods.has(tokens[0]!.toUpperCase())) {
      routeMethod = tokens[0]!.toUpperCase()
      pattern = tokens.slice(1).join(' ')
    } else {
      pattern = key
    }

    if (routeMethod && routeMethod !== method.toUpperCase()) continue

    const urlPattern = new URLPattern({ pathname: pattern })
    if (urlPattern.test({ pathname: path })) return { key, value }
  }

  return null
}
