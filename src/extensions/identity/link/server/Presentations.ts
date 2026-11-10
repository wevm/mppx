import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'
import * as Internal from './internal.js'

/** Issuer JWT types a credential may have. */
const credentialTypes = new Set(['dc+sd-jwt', 'vc+sd-jwt'])
/** Claim names a disclosure may never set (RFC 9901). */
const reserved = new Set([
  '_sd',
  '_sd_alg',
  '...',
  'iss',
  'exp',
  'nbf',
  'vct',
  'vct#integrity',
  'cnf',
  'status',
  'aud',
])
/** Credential members that are structure, not claims. */
const structural = new Set(['_sd', '_sd_alg', 'iss', 'exp', 'nbf', 'iat', 'vct'])

type Jwk = JsonWebKey & { kid?: string | undefined; crv?: string | undefined }

/**
 * Creates a verifier of Link identity presentations (SD-JWT VC with a Key Binding JWT) that
 * needs only Web Crypto and `fetch`, so it runs where `@stripe/agent-identity` does not, such
 * as Cloudflare Workers. It makes the same checks: Link signed the credential with a key from its
 * claims JWKS, the credential has not expired, every disclosure is committed to, and the holder
 * key bound the presentation to `audience`, the nonce and the disclosures within a minute.
 * {@link claims} uses it unless given another verifier.
 */
export function presentationVerifier(config: presentationVerifier.Config): Types.ClaimsVerifier {
  const issuer = (config.issuer ?? Constants.issuer).replace(/\/+$/, '')
  const audience = config.audience.replace(/\/+$/, '')
  const origin = new URL(issuer).origin
  const fetch = config.fetch ?? globalThis.fetch
  const timeout = config.timeout ?? 3_000
  const getMetadata = Internal.metadata({ fetch, issuer, maxAge: 3_600_000, timeout })
  let jwks: { at: number; keys: Promise<Jwk[]> } | undefined

  let refreshedForUnknown = 0

  async function keys(force = false): Promise<Jwk[]> {
    if (!force && jwks && Date.now() - jwks.at < 3_600_000) return jwks.keys
    const promise = getMetadata().then(async (metadata) => {
      if (typeof metadata.claims_jwks_uri !== 'string')
        throw new Error('The issuer metadata has no claims_jwks_uri.')
      const body = await Internal.getJson(metadata.claims_jwks_uri, { fetch, origin, timeout })
      return (Array.isArray(body.keys) ? body.keys : [])
        .filter((key): key is Jwk => !!key && typeof key === 'object')
        .slice(0, 16)
    })
    jwks = { at: Date.now(), keys: promise }
    promise.catch(() => {
      if (jwks?.keys === promise) jwks = undefined
    })
    return promise
  }

  return {
    async verifyClaims(presentation, options) {
      const failures: Types.Failure[] = []
      const fail = (message: string, code = 'invalid_claims_presentation') => {
        failures.push({ code, message })
        return { valid: false as const, failures }
      }
      if (!presentation) return fail('No identity presentation.', 'incomplete_protocol_request')
      if (presentation.length > 65_536) return fail('The presentation is too long.')
      const now = Math.floor(Date.now() / 1_000)
      const parts = presentation.split('~')
      if (parts.length < 2) return fail('The presentation is not an SD-JWT.')
      const issuerJwt = parts[0]!
      const kbJwt = parts.at(-1)!
      const disclosures = parts.slice(1, -1).filter(Boolean)
      if (!kbJwt) return fail('The presentation has no Key Binding JWT.')

      const credential = decodeJws(issuerJwt)
      if (!credential) return fail('The credential is not a compact JWS.')
      const { header, payload } = credential
      if (typeof header.typ !== 'string' || !credentialTypes.has(header.typ))
        return fail('The credential type is not accepted.')
      const alg = algorithm(header.alg)
      if (!alg) return fail('The credential algorithm is not accepted.')
      if (typeof payload.iss !== 'string' || payload.iss.replace(/\/+$/, '') !== issuer)
        return fail(`The credential is not from ${issuer}.`)
      if (typeof payload.vct !== 'string' || !payload.vct) return fail('The credential has no vct.')
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
        return fail('The credential has no exp.')
      if (payload.exp <= now) return fail('The credential has expired.')
      if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now))
        return fail('The credential is not valid yet.')
      if (payload.aud !== undefined && ![payload.aud].flat().includes(audience))
        return fail('The credential is for another audience.')
      const holder = (payload.cnf as { jwk?: unknown } | undefined)?.jwk as Jwk | undefined
      if (!holder || typeof holder !== 'object' || typeof holder.kty !== 'string')
        return fail('The credential has no holder key.')

      // Verifies with the cached keys, then once with fresh ones: Link may have rotated its key,
      // under a new kid or the same one. Refetching is free to provoke, so at most every 30 seconds.
      const kid = typeof header.kid === 'string' ? header.kid : undefined
      let signed = false
      for (const force of [false, true]) {
        if (force && Date.now() - refreshedForUnknown < 30_000) break
        if (force) refreshedForUnknown = Date.now()
        let all: Jwk[]
        try {
          all = await keys(force)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), 'issuer_unavailable')
        }
        const byKid = kid ? all.filter((key) => key.kid === kid) : []
        for (const jwk of byKid.length > 0 ? byKid : all) {
          const key = await importKey(jwk, alg)
          if (key && (await verifyJws(key, alg, issuerJwt))) signed = true
          if (signed) break
        }
        if (signed) break
      }
      if (!signed) return fail('The credential signature does not verify.')

      if (String(payload._sd_alg ?? 'sha-256').toLowerCase() !== 'sha-256')
        return fail('The credential digest algorithm is not supported.')
      const committed = new Set<string>()
      for (const digest of Array.isArray(payload._sd) ? payload._sd : []) {
        if (typeof digest !== 'string' || committed.has(digest))
          return fail('The credential digests are malformed.')
        committed.add(digest)
      }
      if (payload._sd !== undefined && !Array.isArray(payload._sd))
        return fail('The credential digests are malformed.')
      for (const [name, value] of Object.entries(payload))
        if (!structural.has(name) && nested(value))
          return fail('Nested selective disclosure is not supported.')

      const disclosed: Record<string, unknown> = {}
      for (const disclosure of disclosures) {
        if (!committed.has(Internal.toBase64(await Internal.sha256(disclosure))))
          return fail('A disclosure is not committed to by the credential.')
        const bytes = Internal.fromBase64(disclosure)
        let decoded: unknown
        try {
          decoded = bytes && JSON.parse(new TextDecoder().decode(bytes))
        } catch {}
        if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[1] !== 'string')
          return fail('A disclosure is not a [salt, name, value] triple.')
        const [, name, value] = decoded as [unknown, string, unknown]
        if (reserved.has(name)) return fail('A disclosure uses a reserved claim name.')
        if (Object.hasOwn(payload, name) || Object.hasOwn(disclosed, name))
          return fail(`The claim ${JSON.stringify(name.slice(0, 64))} is disclosed twice.`)
        if (nested(value)) return fail('Nested selective disclosure is not supported.')
        Object.defineProperty(disclosed, name, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        })
      }

      const binding = decodeJws(kbJwt)
      if (!binding) return fail('The Key Binding JWT is not a compact JWS.')
      if (binding.header.typ !== 'kb+jwt') return fail('The Key Binding JWT type is not kb+jwt.')
      const kbAlg = algorithm(binding.header.alg)
      if (!kbAlg) return fail('The Key Binding JWT algorithm is not accepted.')
      if (binding.payload.aud !== audience) return fail('The presentation is for another audience.')
      if (binding.payload.nonce !== options.nonce)
        return fail('The presentation nonce does not match the challenge.')
      const iat = binding.payload.iat
      if (typeof iat !== 'number' || !Number.isFinite(iat) || Math.abs(now - iat) > 60)
        return fail('The presentation was not signed within the last minute.')
      const sdHash = Internal.toBase64(
        await Internal.sha256(presentation.slice(0, presentation.lastIndexOf('~') + 1)),
      )
      if (binding.payload.sd_hash !== sdHash)
        return fail('The presentation sd_hash does not match.')
      if (holder.d !== undefined) return fail('The holder key is not a public key.')
      const holderKey = await importKey(holder, kbAlg)
      if (!holderKey || !(await verifyJws(holderKey, kbAlg, kbJwt)))
        return fail('The presentation is not signed by the holder key.')

      const missing = options.requiredClaims.filter((claim) => !Object.hasOwn(disclosed, claim))
      if (missing.length > 0)
        return fail(`The presentation does not disclose: ${missing.join(', ')}.`)
      return {
        valid: true,
        claims: disclosed,
        holderKeyThumbprint: await thumbprint(holder),
        issuer,
        vct: payload.vct,
      }
    },
  }
}

export declare namespace presentationVerifier {
  type Config = {
    /** This server's public origin: the presentation's audience. */
    readonly audience: string
    /** Fetch used for Link's issuer documents. @default globalThis.fetch */
    readonly fetch?: ((input: string, init: RequestInit) => MaybePromise<Response>) | undefined
    /** Issuer URL. Override only for staging and tests. @default 'https://api.link.com' */
    readonly issuer?: string | undefined
    /** Milliseconds each issuer request may take. @default 3000 */
    readonly timeout?: number | undefined
  }
}

type Alg = 'EdDSA' | 'ES256'

function algorithm(value: unknown): Alg | undefined {
  return value === 'EdDSA' || value === 'ES256' ? value : undefined
}

/** Decodes a compact JWS's header and payload, both JSON objects. */
function decodeJws(jws: string) {
  const [header, payload, signature, ...rest] = jws.split('.')
  if (!header || !payload || signature === undefined || rest.length > 0) return undefined
  const object = (segment: string) => {
    const bytes = Internal.fromBase64(segment)
    if (!bytes) return undefined
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  const decoded = { header: object(header), payload: object(payload) }
  if (!decoded.header || !decoded.payload) return undefined
  return decoded as { header: Record<string, unknown>; payload: Record<string, unknown> }
}

/** Imports a public JWK for `alg`, holding it to the key type, use and operations it declares. */
async function importKey(jwk: Jwk, alg: Alg): Promise<CryptoKey | undefined> {
  if (alg === 'EdDSA' && (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')) return undefined
  if (alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256')) return undefined
  if (jwk.d !== undefined) return undefined
  if (jwk.alg !== undefined && jwk.alg !== alg && !(alg === 'EdDSA' && jwk.alg === 'Ed25519'))
    return undefined
  if (jwk.use !== undefined && jwk.use !== 'sig') return undefined
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify')) return undefined
  const { alg: _, key_ops: __, use: ___, kid: ____, ...material } = jwk
  try {
    return await crypto.subtle.importKey(
      'jwk',
      material,
      alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    return undefined
  }
}

async function verifyJws(key: CryptoKey, alg: Alg, jws: string): Promise<boolean> {
  const end = jws.lastIndexOf('.')
  const signature = Internal.fromBase64(jws.slice(end + 1))
  if (!signature) return false
  const header = decodeJws(jws)?.header
  // Only encoded payloads: no unencoded-payload JWS (RFC 7797).
  if (!header || header.alg !== alg || header.b64 === false || header.crit !== undefined)
    return false
  return crypto.subtle.verify(
    alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    new TextEncoder().encode(jws.slice(0, end)),
  )
}

/** RFC 7638 SHA-256 thumbprint of a public JWK. */
async function thumbprint(jwk: Jwk): Promise<string> {
  const members =
    jwk.kty === 'EC'
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : jwk.kty === 'OKP'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
        : { e: jwk.e, kty: jwk.kty, n: jwk.n }
  return Internal.toBase64(await Internal.sha256(JSON.stringify(members)))
}

/** Whether a claim value uses nested selective disclosure. */
function nested(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false
  if (depth > 8) return true
  if (Array.isArray(value))
    return value.some(
      (item) =>
        (!!item && typeof item === 'object' && !Array.isArray(item) && '...' in item) ||
        nested(item, depth + 1),
    )
  if ('_sd' in value || '...' in value) return true
  return Object.values(value).some((item) => nested(item, depth + 1))
}
