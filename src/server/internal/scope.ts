const requestScopes = new WeakMap<Request, string>()

/** Reserved `meta` key used for mppx-managed route/resource scope binding. */
export const reservedMetaKey = '_mppx_scope'

/** Attaches a trusted adapter-derived scope to a Request for this process only. */
export function attach(request: Request, scope: string): Request {
  requestScopes.set(request, scope)
  return request
}

/** Reads a previously attached trusted adapter-derived scope from a Request. */
export function get(request: Request): string | undefined {
  return requestScopes.get(request)
}

/** Returns the reserved mppx scope value from challenge metadata, if present. */
export function read(meta: Record<string, string> | undefined): string | undefined {
  return meta?.[reservedMetaKey]
}

/**
 * Merges the public `scope` option into challenge metadata.
 *
 * Throws when both `scope` and `meta._mppx_scope` are provided with different
 * values so callers have a single authoritative way to bind route scope.
 */
export function merge(parameters: {
  meta?: Record<string, string> | undefined
  scope?: string | undefined
}): Record<string, string> | undefined {
  const { meta, scope } = parameters
  const metaScope = read(meta)

  if (scope !== undefined && metaScope !== undefined && metaScope !== scope) {
    throw new Error(
      `Conflicting scope values: \`scope\` (${scope}) does not match \`meta.${reservedMetaKey}\` (${metaScope}).`,
    )
  }

  if (scope === undefined || metaScope === scope) return meta
  return { ...meta, [reservedMetaKey]: scope }
}
