import { unwrapFetch, withoutPayment } from '../../../client/internal/Fetch.js'
import { Algorithms } from '../Constants.js'
import type { KeyResolver, SignatureAlgorithm } from '../Types.js'

/** The JOSE `alg` (RFC 7518) that names each RFC 9421 algorithm in a JWK. */
const joseAlgorithms = {
  [Algorithms.ed25519]: ['EdDSA', 'Ed25519'],
  [Algorithms.ecdsaP256Sha256]: ['ES256'],
  [Algorithms.ecdsaP384Sha384]: ['ES384'],
  [Algorithms.rsaPssSha512]: ['PS512'],
} as const satisfies Record<SignatureAlgorithm, readonly string[]>

/** The JWK key type and curve, and WebCrypto import parameters, of each algorithm. */
const keyTypes = {
  [Algorithms.ed25519]: { crv: 'Ed25519', kty: 'OKP', importAs: { name: 'Ed25519' } },
  [Algorithms.ecdsaP256Sha256]: {
    crv: 'P-256',
    kty: 'EC',
    importAs: { name: 'ECDSA', namedCurve: 'P-256' },
  },
  [Algorithms.ecdsaP384Sha384]: {
    crv: 'P-384',
    kty: 'EC',
    importAs: { name: 'ECDSA', namedCurve: 'P-384' },
  },
  [Algorithms.rsaPssSha512]: {
    crv: undefined,
    kty: 'RSA',
    importAs: { name: 'RSA-PSS', hash: 'SHA-512' },
  },
} as const satisfies Record<
  SignatureAlgorithm,
  {
    crv: string | undefined
    kty: string
    importAs: AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams
  }
>

/**
 * Creates a TAP key resolver that reads an agent provider's JSON Web Key Set (RFC 7517).
 *
 * Fetches `url` and caches its keys for `ttl` seconds. A key is returned only when its `kid`
 * equals the signature's `keyid`, its `kty` and `crv` fit the signature's `alg`, and any
 * `alg`, `use` or `key_ops` it declares allows that algorithm and verification. An unknown key
 * ID refetches the set at most once every `refreshInterval` seconds, so requests cannot trigger a
 * fetch each. While the URL is unreachable, the last set fetched keeps verifying for up to
 * `maxStale` seconds after it was fetched; after that, verification fails closed.
 *
 * @example
 * ```ts
 * const tap = Tap.Server.verifier({
 *   keyResolver: Tap.Jwks.resolver({ url: 'https://agent-provider.example/.well-known/jwks.json' }),
 *   nonceStore,
 * })
 * ```
 */
export function resolver(options: resolver.Options): KeyResolver {
  const url = new URL(options.url)
  if (url.protocol !== 'https:') throw new TypeError('A TAP JWKS URL must use https.')
  const ttl = (options.ttl ?? 300) * 1_000
  const refreshInterval = (options.refreshInterval ?? 30) * 1_000
  const maxStale = (options.maxStale ?? 3_600) * 1_000
  const timeout = (options.timeout ?? 5) * 1_000
  // Unwrapped, so a key server's 402 is never paid in a process that also runs the client.
  const fetch = unwrapFetch(options.fetch ?? globalThis.fetch)
  // The last set fetched successfully, served while a refetch fails.
  let good: { fetchedAt: number; keys: Map<string, Record<string, unknown>> } | undefined
  // When the last fetch started, so unknown key IDs and failures cannot refetch on every request.
  let attemptedAt = Number.NEGATIVE_INFINITY
  // The fetch in flight, shared by concurrent lookups.
  let pending: Promise<Map<string, Record<string, unknown>>> | undefined

  function load() {
    attemptedAt = Date.now()
    pending ??= fetchKeys(attemptedAt).finally(() => {
      pending = undefined
    })
    return pending
  }

  async function fetchKeys(startedAt: number) {
    const response = await fetch(
      url,
      withoutPayment({
        headers: { accept: 'application/jwk-set+json, application/json' },
        signal: AbortSignal.timeout(timeout),
        // Workers reject 'error'; a redirect is not ok, so it fails below.
        redirect: 'manual',
      }),
    )
    if (!response.ok) throw new Error(`JWKS request failed with ${response.status}.`)
    const body = (await response.json()) as { keys?: unknown } | null
    // A body without a key list is a failed fetch, so it never replaces the last good set.
    if (!body || !Array.isArray(body.keys)) throw new Error('JWKS response has no keys list.')
    const keys = new Map<string, Record<string, unknown>>()
    for (const jwk of body.keys) {
      if (!jwk || typeof jwk !== 'object') continue
      const { kid } = jwk as { kid?: unknown }
      // A repeated kid is ambiguous, so neither key is trusted.
      if (typeof kid !== 'string') continue
      if (keys.has(kid)) keys.set(kid, {})
      else keys.set(kid, jwk as Record<string, unknown>)
    }
    good = { fetchedAt: startedAt, keys }
    return keys
  }

  async function keysFor(keyId: string) {
    const now = Date.now()
    const fresh = good !== undefined && now - good.fetchedAt <= ttl
    if (fresh && good!.keys.has(keyId)) return good!.keys
    // A stale set or an unknown key ID refetches, at most once per refreshInterval.
    if (pending || now - attemptedAt >= refreshInterval) {
      try {
        return await (pending ?? load())
      } catch (error) {
        // A failed refetch for an unknown key ID cannot say it is unknown: it may be newly rotated
        // in. Only a set that already went stale is served through an outage.
        if (!fresh && good && now - good.fetchedAt <= maxStale) return good.keys
        throw error
      }
    }
    if (good && now - good.fetchedAt <= (fresh ? ttl : maxStale)) return good.keys
    throw new Error('The JWKS is unavailable.')
  }

  return async ({ algorithm, keyId }) => {
    const jwk = (await keysFor(keyId)).get(keyId)
    if (!jwk) return undefined
    const { alg, crv, key_ops, kty, use } = jwk
    const type = keyTypes[algorithm]
    if (kty !== type.kty || (type.crv && crv !== type.crv)) return undefined
    if (alg !== undefined && !(joseAlgorithms[algorithm] as readonly unknown[]).includes(alg))
      return undefined
    if (use !== undefined && use !== 'sig') return undefined
    if (key_ops !== undefined && !(Array.isArray(key_ops) && key_ops.includes('verify')))
      return undefined
    // Only the public members are imported, so a published private key is never used.
    const members =
      kty === 'RSA'
        ? ['kty', 'n', 'e']
        : kty === 'EC'
          ? ['kty', 'crv', 'x', 'y']
          : ['kty', 'crv', 'x']
    const publicJwk = Object.fromEntries(
      members.map((member) => [member, jwk[member]]),
    ) as JsonWebKey
    try {
      return await crypto.subtle.importKey('jwk', publicJwk, type.importAs, true, ['verify'])
    } catch {
      return undefined
    }
  }
}

export declare namespace resolver {
  type Options = {
    /** HTTPS URL of the agent provider's JSON Web Key Set. */
    readonly url: string | URL
    /** Fetch implementation. @default globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch | undefined
    /** Seconds a fetched key set is cached. @default 300 */
    readonly ttl?: number | undefined
    /** Seconds before a key set fetch is abandoned. @default 5 */
    readonly timeout?: number | undefined
    /** Minimum seconds between fetches, for unknown key IDs and after failures. @default 30 */
    readonly refreshInterval?: number | undefined
    /**
     * Seconds after its fetch that the last good key set keeps verifying while the URL is
     * unreachable, so a rotated-out key stops working. @default 3600
     */
    readonly maxStale?: number | undefined
  }
}
