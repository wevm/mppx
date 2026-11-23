import type { SignatureEnvelope } from 'ox/tempo'

/** The secp256k1 curve order. */
const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
/** The P256 curve order. */
const p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
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

/**
 * Returns a primitive signature with `s` at most half its curve order: a high `s` becomes the
 * equivalent `n - s` (flipping the secp256k1 recovery parity), including each owner approval of a configurable
 * account signature. Signers such as KMS or HSM backends
 * may return either form; Tempo accepts only the low one. Other envelope types are returned as is.
 */
export function toLowS<envelope extends SignatureEnvelope.SignatureEnvelope>(
  envelope: envelope,
): envelope {
  if (envelope.type === 'configurable')
    return { ...envelope, signatures: envelope.signatures.map((approval) => toLowS(approval)) }
  if (isLowS(envelope)) return envelope
  if (envelope.type === 'secp256k1') {
    const { r, s, yParity } = envelope.signature
    return { ...envelope, signature: { r, s: secp256k1Order - s, yParity: yParity === 0 ? 1 : 0 } }
  }
  if (envelope.type === 'p256' || envelope.type === 'webAuthn')
    return {
      ...envelope,
      signature: { ...envelope.signature, s: p256Order - envelope.signature.s },
    }
  return envelope
}
