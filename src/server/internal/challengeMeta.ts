import { Base64, Secp256k1 } from 'ox'

/** Reserved metadata key for HMAC-bound, per-issuance challenge randomness. */
export const nonceKey = '_mpp_nonce'

/** Nonce key of earlier mppx releases: still ignored when comparing route metadata. */
const legacyNonceKey = '_mppx_nonce'

/** Issuance-only identity nonce of earlier mppx releases with payment-stage verifiers; still ignored. */
const legacyIdentityKey = '_mppx_identity'

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

/** Removes issuance-only metadata when comparing stable route requirements. */
export function routeMeta(
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const { [nonceKey]: _, [legacyNonceKey]: __, [legacyIdentityKey]: ___, ...rest } = meta ?? {}
  return Object.keys(rest).length ? rest : undefined
}
