import { Base64 } from 'ox'

/** A decoded, unverified compact JWS. */
export type Decoded = {
  readonly header: Record<string, any>
  readonly claims: Record<string, any>
  readonly signingInput: Uint8Array<ArrayBuffer>
  readonly signature: Uint8Array<ArrayBuffer>
}

/** ES256 in Web Crypto: the only DPoP algorithm the Tempo ID SDK signs with. */
export const es256 = {
  key: { name: 'ECDSA', namedCurve: 'P-256' },
  sign: { name: 'ECDSA', hash: 'SHA-256' },
} as const

/** Decodes a compact JWS without verifying it, or returns `undefined` if it is malformed. */
export function decode(token: string): Decoded | undefined {
  const parts = token.split('.')
  if (token.length > 16_384 || parts.length !== 3) return undefined
  try {
    const header = JSON.parse(Base64.toString(parts[0]!))
    const claims = JSON.parse(Base64.toString(parts[1]!))
    if (!isObject(header) || !isObject(claims)) return undefined
    return {
      header,
      claims,
      signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      signature: new Uint8Array(Base64.toBytes(parts[2]!)),
    }
  } catch {
    return undefined
  }
}

/** Encodes a JSON value as unpadded base64url. */
export function encode(value: unknown): string {
  return Base64.fromString(JSON.stringify(value), { pad: false, url: true })
}

/** Unpadded base64url SHA-256 of a string, as DPoP's `ath` uses. */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Base64.fromBytes(new Uint8Array(digest), { pad: false, url: true })
}

/** RFC 7638 thumbprint of a P-256 public JWK. */
export function thumbprint(jwk: JsonWebKey): Promise<string> {
  return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}

/** A request URL without its query and fragment, as DPoP's `htu` names it. */
export function htu(url: string | URL): string {
  const parsed = new URL(url)
  return parsed.origin + parsed.pathname
}

/**
 * Returns a lookup of an issuer's RS256 keys by key ID, from `<issuer>/oauth2/jwks`. The set is
 * cached for five minutes, and an unknown key ID refetches it at most every 30 seconds.
 */
export function keys(issuer: string, fetch: typeof globalThis.fetch) {
  let cached: { at: number; keys: Promise<Map<string, CryptoKey>> } | undefined

  async function load() {
    const response = await fetch(`${issuer}/oauth2/jwks`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`The key set request failed with ${response.status}.`)
    const body = (await response.json()) as { keys?: JsonWebKey[] }
    const result = new Map<string, CryptoKey>()
    for (const jwk of body.keys ?? []) {
      const { e, kid, kty, n } = jwk as JsonWebKey & { kid?: string }
      if (kty !== 'RSA' || !kid || !e || !n) continue
      const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      result.set(
        kid,
        await crypto.subtle.importKey('jwk', { e, kty, n }, algorithm, false, ['verify']),
      )
    }
    return result
  }

  function fresh(maxAge: number) {
    if (cached && Date.now() - cached.at < maxAge) return cached.keys
    const entry = { at: Date.now(), keys: load() }
    entry.keys.catch(() => {
      if (cached === entry) cached = undefined
    })
    cached = entry
    return entry.keys
  }

  return async (kid: string): Promise<CryptoKey | undefined> =>
    (await fresh(300_000)).get(kid) ?? (await fresh(30_000)).get(kid)
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
