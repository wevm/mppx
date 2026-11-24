import { Base64, Secp256k1 } from 'ox'

import * as PaymentRequest from '../PaymentRequest.js'

/** Reserved metadata key for HMAC-bound, per-issuance challenge randomness. */
export const nonceKey = '_mpp_nonce'

/** Nonce key of earlier mppx releases: still ignored when comparing route metadata. */
const legacyNonceKey = '_mppx_nonce'

/**
 * Adds fresh issuance randomness (16 random bytes, base64url without padding) under
 * `_mpp_nonce` while preserving application and route metadata. With `enabled: false`,
 * returns the metadata unchanged.
 */
export function withNonce(
  meta: Record<string, string> | undefined,
  enabled = true,
): Record<string, string> | undefined {
  if (!enabled) return meta
  // Ox's key generation uses runtime-specific secure randomness, including Node without global
  // Web Crypto; 16 of its 32 uniformly random bytes make the nonce.
  const random = Secp256k1.randomPrivateKey({ as: 'Bytes' }).slice(0, 16)
  const nonce = Base64.fromBytes(random, { url: true, pad: false })
  return { ...meta, [nonceKey]: nonce }
}

/**
 * Whether the challenge carries a per-issuance nonce (`_mpp_nonce`, or `_mppx_nonce` from
 * earlier releases). Reads `opaque` when present, the value the challenge HMAC covers, and
 * `meta` only otherwise.
 */
export function hasNonce(challenge: {
  meta?: Record<string, string> | undefined
  opaque?: string | undefined
}): boolean {
  const { meta, opaque } = challenge
  const has = (value: Record<string, unknown> | undefined) =>
    typeof value?.[nonceKey] === 'string' || typeof value?.[legacyNonceKey] === 'string'
  if (opaque === undefined) return has(meta)
  try {
    return has(PaymentRequest.deserialize(opaque) as Record<string, unknown>)
  } catch {
    return false
  }
}

/**
 * Reserved metadata key marking a challenge whose method accepts some of its credentials for a
 * while after it expires. Bound by the challenge HMAC, so a challenge issued without it, by an
 * earlier release or with no grace configured, never gets that grace.
 */
const expiryGraceKey = '_mppx_expiry_grace'

/** Sets the expiry grace marker when `grace` is true and removes any copy of it otherwise. */
export function withExpiryGrace(
  meta: Record<string, string> | undefined,
  grace: boolean,
): Record<string, string> | undefined {
  const { [expiryGraceKey]: _, ...rest } = meta ?? {}
  if (grace) return { ...rest, [expiryGraceKey]: '1' }
  return meta === undefined || !(expiryGraceKey in meta) ? meta : rest
}

/**
 * Whether the challenge carries the expiry grace marker. Reads `opaque` when present, the
 * value the challenge HMAC covers, and `meta` only otherwise.
 */
export function hasExpiryGrace(challenge: {
  meta?: Record<string, string> | undefined
  opaque?: string | undefined
}): boolean {
  const { meta, opaque } = challenge
  if (opaque === undefined) return meta?.[expiryGraceKey] === '1'
  try {
    const decoded = PaymentRequest.deserialize(opaque) as Record<string, unknown>
    return decoded?.[expiryGraceKey] === '1'
  } catch {
    return false
  }
}

/** Issuance-only identity nonce of earlier mppx releases with payment-stage verifiers; still ignored. */
const legacyIdentityKey = '_mppx_identity'

/** Removes issuance-only metadata when comparing stable route requirements. */
export function routeMeta(
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const {
    [nonceKey]: _,
    [legacyNonceKey]: __,
    [legacyIdentityKey]: ___,
    [expiryGraceKey]: ____,
    ...rest
  } = meta ?? {}
  return Object.keys(rest).length ? rest : undefined
}
