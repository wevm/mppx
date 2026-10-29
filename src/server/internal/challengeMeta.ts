import { Secp256k1 } from 'ox'

/** Reserved metadata key for HMAC-bound, per-issuance challenge randomness. */
const nonceKey = '_mppx_nonce'

/** Adds fresh issuance randomness while preserving application and route metadata. */
export function withNonce(meta: Record<string, string> | undefined): Record<string, string> {
  // Ox uses runtime-specific secure randomness, including Node without global Web Crypto.
  return { ...meta, [nonceKey]: Secp256k1.randomPrivateKey() }
}

/** Reserved metadata key for the HMAC-bound identity nonce shared by every offer in one 402. */
const identityKey = '_mppx_identity'

/** Returns fresh randomness for an identity nonce. */
export function createNonce(): string {
  return Secp256k1.randomPrivateKey()
}

/** Adds an identity nonce to challenge metadata. */
export function withIdentity(
  meta: Record<string, string> | undefined,
  nonce: string | undefined,
): Record<string, string> | undefined {
  if (nonce === undefined) return meta
  return { ...meta, [identityKey]: nonce }
}

/** Reads the identity nonce from challenge metadata. */
export function identity(meta: Record<string, string> | undefined): string | undefined {
  return meta?.[identityKey]
}

/** Removes issuance-only metadata when comparing stable route requirements. */
export function routeMeta(
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const { [nonceKey]: _, [identityKey]: __, ...rest } = meta ?? {}
  return Object.keys(rest).length ? rest : undefined
}
