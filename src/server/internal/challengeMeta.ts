import { Secp256k1 } from 'ox'

/** Reserved metadata key for HMAC-bound, per-issuance challenge randomness. */
const nonceKey = '_mppx_nonce'

/** Adds fresh issuance randomness while preserving application and route metadata. */
export function withNonce(meta: Record<string, string> | undefined): Record<string, string> {
  // Ox uses runtime-specific secure randomness, including Node without global Web Crypto.
  return { ...meta, [nonceKey]: Secp256k1.randomPrivateKey() }
}

/** Removes issuance-only metadata when comparing stable route requirements. */
export function routeMeta(
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const { [nonceKey]: _, ...rest } = meta ?? {}
  return Object.keys(rest).length ? rest : undefined
}
