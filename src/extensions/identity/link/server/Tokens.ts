import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'
import { equal, fromBase64, getJson, sha256, toBase64 } from './internal.js'

/** Privacy Pass token type of a Link attestation: blind RSA (RFC 9578). */
const tokenType = 0x0002
/** Byte sizes of a token's fields. */
const sizes = { nonce: 32, digest: 32, keyId: 32, authenticator: 256 } as const
const tokenSize = 2 + sizes.nonce + sizes.digest + sizes.keyId + sizes.authenticator
const inputSize = tokenSize - sizes.authenticator
/** `AlgorithmIdentifier { rsaEncryption, NULL }`, the RSA key encoding Web Crypto imports. */
const rsaEncryption = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]
/** `AlgorithmIdentifier { id-RSASSA-PSS, SHA-384, MGF1-SHA-384, salt 48 }`, the one RFC 9578 allows. */
const rsaPss = [
  0x30, 0x3d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a, 0x30, 0x30, 0xa0,
  0x0d, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0xa1, 0x1a,
  0x30, 0x18, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30, 0x0b, 0x06,
  0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0xa2, 0x03, 0x02, 0x01, 0x30,
]

type Key = {
  readonly key: CryptoKey
  readonly spki: string
  readonly notBefore?: number | undefined
}

/**
 * Creates a verifier of Link Agent Attestation Tokens that needs only Web Crypto and `fetch`,
 * so it runs where `@stripe/agent-identity` can't import Link's RSASSA-PSS token key, such as
 * Cloudflare Workers. It makes the same checks: the key is in the token-key directory of Link's
 * issuer metadata, the token answers Link's stable bearer challenge, and its RSA-PSS (SHA-384)
 * signature verifies. {@link attestation} uses it unless given another verifier.
 */
export function tokenVerifier(config: tokenVerifier.Config = {}): Types.AttestationVerifier {
  const issuer = (config.issuer ?? Constants.issuer).replace(/\/+$/, '')
  const issuerOrigin = new URL(issuer).origin
  const maxKeyAge = (config.maxKeyAge ?? 900) * 1_000
  const fetch = config.fetch ?? globalThis.fetch
  let cache: { at: number; keys: ReadonlyMap<string, Key> } | undefined
  let loading: Promise<ReadonlyMap<string, Key>> | undefined
  // An unknown key ID is free to mint: refresh for one at most every 30 seconds.
  let refreshedForUnknown = 0

  const get = (url: string) =>
    getJson(url, { fetch, origin: issuerOrigin, timeout: config.timeout ?? 3_000 })

  async function load(): Promise<ReadonlyMap<string, Key>> {
    const metadata = await get(`${issuer}/.well-known/aap-issuer`)
    if (typeof metadata.issuer !== 'string' || metadata.issuer.replace(/\/+$/, '') !== issuer)
      throw new Error('The issuer metadata names another issuer.')
    if (typeof metadata.token_keys !== 'string')
      throw new Error('The issuer metadata has no token_keys.')
    const directory = await get(metadata.token_keys)
    const entries = Array.isArray(directory['token-keys']) ? directory['token-keys'] : []
    const keys = new Map<string, Key>()
    for (const entry of entries as Record<string, unknown>[]) {
      if (entry?.['token-type'] !== tokenType || typeof entry['token-key'] !== 'string') continue
      const spki = fromBase64(entry['token-key'])
      const key = spki && (await importKey(spki))
      if (!spki || !key) continue
      const notBefore = typeof entry['not-before'] === 'number' ? entry['not-before'] : undefined
      keys.set(toBase64(await sha256(spki)), { key, notBefore, spki: toBase64(spki) })
    }
    if (keys.size === 0) throw new Error(`${issuer} published no usable token key.`)
    cache = { at: Date.now(), keys }
    return keys
  }

  function keys(force = false): Promise<ReadonlyMap<string, Key>> {
    if (!force && cache && Date.now() - cache.at < maxKeyAge) return Promise.resolve(cache.keys)
    loading ??= load().finally(() => {
      loading = undefined
    })
    return loading
  }

  const challenge = encodeChallenge(new URL(issuer).host)
  const failure = (code: string, message: string) => ({
    valid: false as const,
    failures: [{ code, message }],
  })

  return {
    async attestationChallenge() {
      const now = Date.now() / 1_000
      const encoded = toBase64(challenge, true)
      const wwwAuthenticate = [...(await keys()).values()]
        .filter((key) => key.notBefore === undefined || now >= key.notBefore)
        .map(
          (key) => `PrivateToken challenge="${encoded}", token-key="${pad(key.spki)}", max-age=300`,
        )
      return { wwwAuthenticate }
    },
    async verifyAttestation(authorization) {
      if (!authorization)
        return failure('incomplete_protocol_request', 'No PrivateToken credential.')
      const raw = parseAuthorization(authorization)
      if (typeof raw === 'string') return failure('malformed_protocol_input', raw)
      if (raw.length !== tokenSize)
        return failure(
          'malformed_protocol_input',
          `The token is ${raw.length} bytes, expected ${tokenSize}.`,
        )
      if (((raw[0]! << 8) | raw[1]!) !== tokenType)
        return failure('malformed_protocol_input', 'The token is not a blind RSA token.')
      const digest = raw.slice(2 + sizes.nonce, 2 + sizes.nonce + sizes.digest)
      if (!equal(digest, await sha256(challenge)))
        return failure('challenge_mismatch', 'The token answers another challenge.')
      const keyId = toBase64(raw.slice(inputSize - sizes.keyId, inputSize))
      let key: Key | undefined
      try {
        key = (await keys()).get(keyId)
        if (!key && Date.now() - refreshedForUnknown > 30_000) {
          refreshedForUnknown = Date.now()
          key = (await keys(true)).get(keyId)
        }
      } catch (error) {
        return failure('issuer_unavailable', error instanceof Error ? error.message : String(error))
      }
      if (!key) return failure('unknown_issuer', 'Link does not publish the token key.')
      const valid = await crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength: 48 },
        key.key,
        raw.slice(inputSize),
        raw.slice(0, inputSize),
      )
      if (!valid) return failure('invalid_private_token', 'The token signature does not verify.')
      return { valid: true, bindingMode: 'bearer', issuer, tokenKeyId: keyId }
    },
  }
}

export declare namespace tokenVerifier {
  type Config = {
    /** Fetch used for Link's issuer documents. @default globalThis.fetch */
    readonly fetch?: ((input: string, init: RequestInit) => MaybePromise<Response>) | undefined
    /** Issuer URL. Override only for staging and tests. @default 'https://api.link.com' */
    readonly issuer?: string | undefined
    /** Seconds before the token keys are fetched again. @default 900 */
    readonly maxKeyAge?: number | undefined
    /** Milliseconds each issuer request may take. @default 3000 */
    readonly timeout?: number | undefined
  }
}

/** The stable TokenChallenge for `issuerName`: no redemption context, no origin info. */
function encodeChallenge(issuerName: string): Uint8Array<ArrayBuffer> {
  const name = new TextEncoder().encode(issuerName)
  return new Uint8Array([
    tokenType >> 8,
    tokenType & 0xff,
    name.length >> 8,
    name.length & 0xff,
    ...name,
    0,
    0,
    0,
  ])
}

/** Returns the token bytes of a `PrivateToken token="…"` credential, or why it is malformed. */
function parseAuthorization(value: string): Uint8Array<ArrayBuffer> | string {
  if (value.length > 8_192) return 'Authorization is too long.'
  const match = /^\s*PrivateToken[ \t]+(.*)$/is.exec(value)
  if (!match || /[\r\n]/.test(value)) return 'Authorization is not a PrivateToken credential.'
  const tokens = [...match[1]!.matchAll(/(?:^|,)\s*token\s*=\s*(?:"([^"]*)"|([^,\s]*))/gi)]
  if (tokens.length !== 1) return 'The credential needs exactly one token parameter.'
  const bytes = fromBase64(tokens[0]![1] ?? tokens[0]![2] ?? '')
  return bytes ?? 'The token is not base64url.'
}

/** Imports an RSA token key, re-wrapping RFC 9578's id-RSASSA-PSS encoding for Web Crypto. */
async function importKey(spki: Uint8Array<ArrayBuffer>): Promise<CryptoKey | undefined> {
  try {
    const outer = tlv(spki, 0)
    if (outer.tag !== 0x30 || outer.end !== spki.length) return undefined
    const algorithm = tlv(spki, outer.start)
    const bits = tlv(spki, algorithm.end)
    if (bits.tag !== 0x03 || bits.end !== outer.end) return undefined
    const identifier = [...spki.slice(outer.start, algorithm.end)]
    const pss = equal(identifier, rsaPss)
    if (!pss && !equal(identifier, rsaEncryption)) return undefined
    const importable = pss
      ? sequence([...rsaEncryption, ...spki.slice(algorithm.end, bits.end)])
      : spki
    const key = await crypto.subtle.importKey(
      'spki',
      importable,
      { name: 'RSA-PSS', hash: 'SHA-384' },
      false,
      ['verify'],
    )
    const { modulusLength } = key.algorithm as RsaHashedKeyAlgorithm
    return modulusLength === sizes.authenticator * 8 ? key : undefined
  } catch {
    return undefined
  }
}

/** Reads one DER tag-length-value at `offset`. */
function tlv(bytes: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = bytes[offset]!
  let length = bytes[offset + 1]!
  let start = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 2) throw new Error('Unsupported DER length.')
    length = 0
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[start + i]!
    start += count
  }
  if (start + length > bytes.length) throw new Error('Truncated DER.')
  return { tag, start, end: start + length }
}

/** A DER SEQUENCE of `contents`. */
function sequence(contents: number[]): Uint8Array<ArrayBuffer> {
  const length =
    contents.length < 0x80
      ? [contents.length]
      : contents.length < 0x100
        ? [0x81, contents.length]
        : [0x82, contents.length >> 8, contents.length & 0xff]
  return new Uint8Array([0x30, ...length, ...contents])
}

function pad(value: string): string {
  return value + '='.repeat((4 - (value.length % 4)) % 4)
}
