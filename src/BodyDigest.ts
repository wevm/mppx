import { Base64, Bytes, Hash } from 'ox'

import { constantTimeEqual } from './internal/constantTimeEqual.js'

/**
 * A body digest string in the format "algorithm=base64hash".
 *
 * @example
 * ```ts
 * import { BodyDigest } from 'mppx'
 *
 * const digest: BodyDigest.BodyDigest = 'sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE'
 * ```
 */
export type BodyDigest = `sha-256=${string}`

/**
 * Computes a SHA-256 digest of the given body.
 *
 * @param body - The body to digest (string, object or raw bytes).
 * @returns A digest string in the format "sha-256=base64hash".
 *
 * @example
 * ```ts
 * import { BodyDigest } from 'mppx'
 *
 * const digest = BodyDigest.compute({ amount: '1000' })
 * // => 'sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE'
 * ```
 */
export function compute(body: Record<string, unknown> | string | Uint8Array): BodyDigest {
  // Raw bytes are hashed as is, so binary bodies and a leading BOM keep their digest.
  const bytes =
    body instanceof Uint8Array
      ? body
      : Bytes.fromString(typeof body === 'object' ? JSON.stringify(body) : body)
  const hash = Hash.sha256(bytes, { as: 'Bytes' })
  const base64 = Base64.fromBytes(hash)
  return `sha-256=${base64}`
}

/**
 * Verifies that a digest matches the given body.
 *
 * @param digest - The digest to verify.
 * @param body - The body to verify against.
 * @returns True if the digest matches, false otherwise.
 *
 * @example
 * ```ts
 * import { BodyDigest } from 'mppx'
 *
 * const isValid = BodyDigest.verify(digest, '{"amount":"1000"}')
 * ```
 */
export function verify(
  digest: BodyDigest,
  body: Record<string, unknown> | string | Uint8Array,
): boolean {
  return constantTimeEqual(compute(body), normalize(digest))
}

/**
 * Accepts the RFC 9530 byte-sequence form `sha-256=:base64hash:` (the form the
 * Payment spec shows) by stripping its colons and restoring any padding it
 * omits (RFC 8941 `4.2.7). Other text is left unchanged.
 */
function normalize(digest: string): string {
  const match = /^sha-256=:([A-Za-z0-9+/]+)=*:$/.exec(digest)
  if (!match) return digest
  const hash = match[1]!
  return `sha-256=${hash}${'='.repeat((4 - (hash.length % 4)) % 4)}`
}
