const httpMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** Extracts the pathname from a URL, stripping the optional `basePath` prefix. Returns `null` if the path doesn't match. */
export function pathname(url: URL, basePath?: string): string | null {
  let pathname = url.pathname
  if (basePath) {
    const base = basePath.replace(/\/+$/, '')
    if (!(pathname === base || pathname.startsWith(`${base}/`))) return null
    pathname = pathname.slice(base.length)
  }
  return pathname
}

/** Splits a `/{serviceId}/rest/of/path` pathname into its service ID and upstream path. */
export function parse(pathname: string): { serviceId: string; upstreamPath: string } | null {
  const segments = pathname.split('/').filter(Boolean)
  const serviceId = segments[0]
  if (!serviceId) return null

  const upstreamPath = `/${segments.slice(1).join('/')}`
  return { serviceId, upstreamPath }
}

/** Finds the first route matching both the HTTP method and path (via `URLPattern`). */
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

/** Finds the first route matching the path, ignoring the HTTP method. Optional `filter` predicate can exclude routes. */
export function matchPath(
  routes: Record<string, unknown>,
  path: string,
  filter?: (value: unknown) => boolean,
): { key: string; value: unknown } | null {
  let match: { key: string; value: unknown } | null = null
  for (const [key, value] of Object.entries(routes)) {
    if (filter && !filter(value)) continue
    const { pattern } = parseRouteKey(key)
    const urlPattern = new URLPattern({ pathname: pattern })
    if (!urlPattern.test({ pathname: path })) continue
    if (match) return null
    match = { key, value }
  }
  return match
}

function parseRouteKey(key: string): { method: string | undefined; pattern: string } {
  const tokens = key.trim().split(/\s+/)
  if (tokens.length >= 2 && httpMethods.has(tokens[0]!.toUpperCase())) {
    return { method: tokens[0]!.toUpperCase(), pattern: tokens.slice(1).join(' ') }
  }
  return { method: undefined, pattern: key }
}
