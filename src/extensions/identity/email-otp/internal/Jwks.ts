import { Constants } from './Constants.js'
import type * as Types from './Types.js'

/**
 * Creates a key resolver that reads an issuer's JSON Web Key Set.
 *
 * Fetches `<issuer>/.well-known/jwks.json` and caches its Ed25519 keys for
 * `ttl` seconds. An unknown key ID refetches the set at most once every
 * `refreshInterval` seconds per issuer, and concurrent lookups share one fetch,
 * so callers cannot trigger a fetch per request. While the issuer is
 * unreachable, the last key set fetched successfully keeps verifying for up to
 * `maxStale` seconds after it was fetched; after that, verification fails closed.
 */
export function resolver(options: resolver.Options = {}): Types.KeyResolver {
  const ttl = (options.ttl ?? 300) * 1_000
  const refreshInterval = (options.refreshInterval ?? 30) * 1_000
  const maxStale = (options.maxStale ?? 3_600) * 1_000
  const timeout = (options.timeout ?? 5) * 1_000
  const fetch = options.fetch ?? globalThis.fetch
  // The newest fetch per issuer, started at `startedAt`; shared by concurrent lookups.
  const sets = new Map<
    string,
    { failed: boolean; startedAt: number; keys: Promise<Map<string, CryptoKey>> }
  >()
  // The last set fetched successfully per issuer, served while a refetch fails.
  const good = new Map<string, { fetchedAt: number; keys: Map<string, CryptoKey> }>()

  function load(issuer: string) {
    const startedAt = Date.now()
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
      good.set(issuer, { fetchedAt: startedAt, keys: result })
      return result
    })()
    const entry = { failed: false, startedAt, keys }
    // A failed fetch is retried after `refreshInterval` rather than cached for `ttl`.
    keys.catch(() => {
      entry.failed = true
    })
    sets.set(issuer, entry)
    return entry
  }

  /** The newest fetch, or one started now if the newest is older than `age`. */
  function current(issuer: string, age: number) {
    const entry = sets.get(issuer)
    const limit = entry?.failed ? Math.min(age, refreshInterval) : age
    return entry && Date.now() - entry.startedAt <= limit ? entry : load(issuer)
  }

  /** Awaits a fetch, falling back to the last good set while it is within `maxStale`. */
  async function keysOf(issuer: string, entry: { keys: Promise<Map<string, CryptoKey>> }) {
    try {
      return await entry.keys
    } catch (error) {
      const last = good.get(issuer)
      if (last && Date.now() - last.fetchedAt <= maxStale) return last.keys
      throw error
    }
  }

  return async ({ issuer, keyId }) => {
    const keys = await keysOf(issuer, current(issuer, ttl))
    if (keys.has(keyId)) return keys.get(keyId)
    // An unknown key ID: join the newest fetch, or start one if it is old enough.
    const refreshed = await keysOf(issuer, current(issuer, refreshInterval))
    return refreshed.get(keyId)
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
    /** Minimum seconds between refetches for an unknown key ID, per issuer. @default 30 */
    refreshInterval?: number | undefined
    /**
     * Seconds after its fetch that the last good key set keeps verifying while
     * the issuer is unreachable, so a rotated-out key stops working. @default 3600
     */
    maxStale?: number | undefined
  }
}
