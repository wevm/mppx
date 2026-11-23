import type { SignatureEnvelope } from 'ox/tempo'

/** Half the secp256k1 curve order. */
const secp256k1HalfOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
/** Half the P256 curve order. */
const p256HalfOrder = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n

/**
 * Returns whether a primitive signature's `s` is at most half its curve order. Tempo rejects
 * secp256k1, P256 and WebAuthn signatures with a higher `s`, so a signature that verifies
 * off-chain without this check may never settle. Other envelope types return `true`.
 */
export function isLowS(envelope: SignatureEnvelope.SignatureEnvelope): boolean {
  if (envelope.type === 'secp256k1') return envelope.signature.s <= secp256k1HalfOrder
  if (envelope.type === 'p256' || envelope.type === 'webAuthn')
    return envelope.signature.s <= p256HalfOrder
  return true
}
