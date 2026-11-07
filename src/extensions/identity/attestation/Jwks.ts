import { Constants } from './Constants.js'
import type * as Types from './Types.js'

/**
 * Creates a key resolver that reads an issuer's JSON Web Key Set.
 *
 * Fetches `<issuer>/.well-known/jwks.json` and caches its Ed25519 keys for
 * `ttl` seconds. An unknown key ID refetches the set at most once every
 * `refreshInterval` seconds, so key rotation is picked up without letting
 * callers trigger a fetch per request. While the issuer is unreachable, the
 * last key set fetched successfully keeps verifying.
 */
export function resolver(options: resolver.Options = {}): Types.KeyResolver {
  const ttl = (options.ttl ?? 300) * 1_000
  const refreshInterval = (options.refreshInterval ?? 30) * 1_000
  const fetch = options.fetch ?? globalThis.fetch
  const sets = new Map<string, { fetchedAt: number; keys: Promise<Map<string, CryptoKey>> }>()
  // The last set fetched successfully per issuer, served while a refetch fails.
  const good = new Map<string, Map<string, CryptoKey>>()
  const timeout = (options.timeout ?? 5) * 1_000

  function load(issuer: string) {
    const keys = (async () => {
      const response = await fetch(`${issuer.replace(/\/+$/, '')}${Constants.jwksPath}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
        // Workers reject 'error'; a redirect is not ok, so it fails below.
        redirect: 'manual',
      })
      if (!response.ok) throw new Error(`JWKS request failed with ${response.status}.`)
      const body = (await response.json()) as { keys?: unknown }
      const result = new Map<string, CryptoKey>()
      for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
        if (!jwk || typeof jwk !== 'object') continue
        const { crv, kid, kty, x } = jwk as Record<string, unknown>
        if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof kid !== 'string')
          continue
        result.set(
          kid,
          await crypto.subtle.importKey('jwk', { crv, kty, x }, { name: 'Ed25519' }, true, [
            'verify',
          ]),
        )
      }
      good.set(issuer, result)
      return result
    })()
    const entry = { fetchedAt: Date.now(), keys }
    sets.set(issuer, entry)
    // A failed fetch is retried after `refreshInterval` rather than cached for `ttl`.
    keys.catch(() => {})
    return entry
  }

  return async ({ issuer, keyId }) => {
    let entry = sets.get(issuer)
    if (!entry || Date.now() - entry.fetchedAt > ttl) entry = load(issuer)
    let keys = await entry.keys.catch(() => good.get(issuer))
    if (keys?.has(keyId)) return keys.get(keyId)
    if (Date.now() - entry.fetchedAt < refreshInterval) {
      // Report a failed fetch as such rather than as an unknown key ID.
      if (!keys) await entry.keys
      return undefined
    }
    keys = await load(issuer).keys.catch((error) => {
      if (!keys) throw error
      return keys
    })
    return keys.get(keyId)
  }
}

export declare namespace resolver {
  type Options = {
    /** Fetch implementation. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
    /** Seconds a fetched key set is cached. @default 300 */
    ttl?: number | undefined
    /** Seconds before a key set fetch is abandoned. @default 5 */
    timeout?: number | undefined
    /** Minimum seconds between refetches for an unknown key ID. @default 30 */
    refreshInterval?: number | undefined
  }
}
