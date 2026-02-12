const httpMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

export function pathname(url: URL, basePath?: string): string | null {
  let pathname = url.pathname
  if (basePath) {
    const base = basePath.replace(/\/+$/, '')
    if (!pathname.startsWith(base)) return null
    pathname = pathname.slice(base.length)
  }
  return pathname
}

export function parse(pathname: string): { serviceId: string; upstreamPath: string } | null {
  const segments = pathname.split('/').filter(Boolean)
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
    const { method: routeMethod, pattern } = parseRouteKey(key)
    if (routeMethod && routeMethod !== method.toUpperCase()) continue
    const urlPattern = new URLPattern({ pathname: pattern })
    if (urlPattern.test({ pathname: path })) return { key, value }
  }
  return null
}

export function matchPath(
  routes: Record<string, unknown>,
  path: string,
): { key: string; value: unknown } | null {
  for (const [key, value] of Object.entries(routes)) {
    const { pattern } = parseRouteKey(key)
    const urlPattern = new URLPattern({ pathname: pattern })
    if (urlPattern.test({ pathname: path })) return { key, value }
  }
  return null
}

function parseRouteKey(key: string): { method: string | undefined; pattern: string } {
  const tokens = key.trim().split(/\s+/)
  if (tokens.length >= 2 && httpMethods.has(tokens[0]!.toUpperCase())) {
    return { method: tokens[0]!.toUpperCase(), pattern: tokens.slice(1).join(' ') }
  }
  return { method: undefined, pattern: key }
}
