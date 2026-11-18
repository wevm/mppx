import type { IncomingMessage } from 'node:http'

const normalizedHosts = new WeakMap<readonly string[], ReadonlySet<string>>()

/** Validates every incoming authority before Node or Express normalizes duplicate headers. */
export function isAllowed(
  request: Pick<IncomingMessage, 'headers' | 'rawHeaders'>,
  allowedHosts: readonly string[] | undefined,
  urlAuthority: string | undefined,
  allowNormalizedOnly = false,
): boolean {
  if (allowedHosts === undefined) return true
  if (typeof urlAuthority !== 'string' || urlAuthority.length === 0) return false
  const authorities: string[] = [urlAuthority]
  const names = new Set<string>()
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase()
    if (name !== 'host' && name !== ':authority') continue
    if (names.has(name)) return false
    names.add(name)
    authorities.push(request.rawHeaders[i + 1] ?? '')
  }
  const host = request.headers.host
  const authority = request.headers[':authority']
  if (host !== undefined) authorities.push(host)
  if (authority !== undefined) {
    if (typeof authority !== 'string') return false
    authorities.push(authority)
  }
  if (
    names.size === 0 &&
    (!allowNormalizedOnly || (typeof host !== 'string' && typeof authority !== 'string'))
  )
    return false
  const expected = authorities[0]?.toLowerCase()
  if (expected === undefined || !authorities.every((value) => value.toLowerCase() === expected))
    return false
  let allowed = normalizedHosts.get(allowedHosts)
  if (!allowed) {
    allowed = new Set(allowedHosts.map((value) => value.toLowerCase()))
    normalizedHosts.set(allowedHosts, allowed)
  }
  return allowed.has(expected)
}
