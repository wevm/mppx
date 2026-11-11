import { unwrapFetch, withoutPayment } from '../../../client/internal/Fetch.js'
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
  // Unwrapped, so an issuer's 402 is never paid in a process that also runs the client.
  const fetch = unwrapFetch(options.fetch ?? globalThis.fetch)
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
      const response = await fetch(
        `${issuer.replace(/\/+$/, '')}${Constants.jwksPath}`,
        withoutPayment({
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
          // Workers reject 'error'; a redirect is not ok, so it fails below.
          redirect: 'manual',
        }),
      )
      if (!response.ok) throw new Error(`JWKS request failed with ${response.status}.`)
      const body = (await response.json()) as { keys?: unknown } | null
      // A body without a key list is a failed fetch, so it never replaces the last good set.
      if (!body || !Array.isArray(body.keys)) throw new Error('JWKS response has no keys list.')
      const result = new Map<string, CryptoKey>()
      for (const jwk of body.keys) {
        if (!jwk || typeof jwk !== 'object') continue
        const { alg, crv, key_ops, kid, kty, use, x } = jwk as Record<string, unknown>
        if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof kid !== 'string')
          continue
        // Honor the issuer's restrictions on what the key may do.
        if (use !== undefined && use !== 'sig') continue
        if (alg !== undefined && alg !== 'EdDSA' && alg !== 'Ed25519') continue
        if (key_ops !== undefined && !(Array.isArray(key_ops) && key_ops.includes('verify')))
          continue
        // A malformed key is skipped, so it cannot take the issuer's other keys down.
        try {
          result.set(
            kid,
            await crypto.subtle.importKey('jwk', { crv, kty, x }, { name: 'Ed25519' }, true, [
              'verify',
            ]),
          )
        } catch {}
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
    // A known key in a set fetched within `ttl` is served at once, so a refetch
    // an unknown key ID started does not hold up other lookups.
    const last = good.get(issuer)
    if (last && Date.now() - last.fetchedAt <= ttl && last.keys.has(keyId))
      return last.keys.get(keyId)
    const keys = await keysOf(issuer, current(issuer, ttl))
    if (keys.has(keyId)) return keys.get(keyId)
    // An unknown key ID: join the newest fetch, or start one if it is old enough.
    // If that fetch fails, a stale set cannot say the key is unknown (it may be
    // newly rotated in), so the outage is thrown and answered with 503.
    const entry = current(issuer, refreshInterval)
    try {
      return (await entry.keys).get(keyId)
    } catch (error) {
      const stale = good.get(issuer)
      if (stale && Date.now() - stale.fetchedAt <= maxStale && stale.keys.has(keyId))
        return stale.keys.get(keyId)
      throw error
    }
  }
}

export declare namespace resolver {
  type Options = {
    /** Fetch implementation. @default globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch | undefined
    /** Seconds a fetched key set is cached. @default 300 */
    readonly ttl?: number | undefined
    /** Seconds before a key set fetch is abandoned. @default 5 */
    readonly timeout?: number | undefined
    /** Minimum seconds between refetches for an unknown key ID, per issuer. @default 30 */
    readonly refreshInterval?: number | undefined
    /**
     * Seconds after its fetch that the last good key set keeps verifying while
     * the issuer is unreachable, so a rotated-out key stops working. @default 3600
     */
    readonly maxStale?: number | undefined
  }
}
