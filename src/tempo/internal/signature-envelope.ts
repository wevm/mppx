import { SignatureEnvelope } from 'ox/tempo'
import type { Hex } from 'viem'

function isPrimitiveEnvelope(type: string): boolean {
  return type === 'secp256k1' || type === 'p256' || type === 'webAuthn'
}

/**
 * Canonicalizes a fresh TIP-1020 primitive signature for transport. Keychain
 * wrappers, multisig signatures, and magic-suffixed encodings are rejected.
 */
export function serializeCanonicalEnvelope(signature: Hex, subject: string): Hex {
  const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
  if (!isPrimitiveEnvelope(envelope.type))
    throw new Error(
      `${subject} require a TIP-1020 primitive signature; received "${envelope.type}".`,
    )
  return SignatureEnvelope.serialize(envelope)
}

/**
 * Parses an incoming signature into a canonical TIP-1020 primitive envelope.
 * Returns `undefined` for wrapper envelopes and aliased (non-canonical)
 * encodings, so verified signatures can be replayed on-chain byte-for-byte.
 */
export function parseCanonicalEnvelope(
  signature: Hex,
): SignatureEnvelope.SignatureEnvelope | undefined {
  const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
  if (!isPrimitiveEnvelope(envelope.type)) return undefined
  if (SignatureEnvelope.serialize(envelope).toLowerCase() !== signature.toLowerCase())
    return undefined
  return envelope
}
