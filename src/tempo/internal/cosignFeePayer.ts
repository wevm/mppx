import type { Account } from 'viem/accounts'
import { Address as OxAddress, Signature as OxSignature, Secp256k1 } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'

/**
 * Co-signs a serialized Tempo transaction with a fee payer account.
 *
 * This operates directly on the ox-level envelope to avoid re-serialization
 * through viem's `signTransaction` action, which can produce mismatched
 * signing payloads when the original transaction was serialized by a
 * different client (e.g., Rust/alloy). The key difference is how the fee
 * payer placeholder is encoded:
 *
 * - **Rust/alloy**: encodes the placeholder as a zero-valued signature
 *   tuple `[0, 0x00…, 0x00…]` (RLP list: `c3 80 80 80`)
 * - **ox/viem**: uses `null`, serialized as a single `0x00` byte
 *
 * The signing payload (`getSignPayload`) differs between these two
 * representations, so we normalize the zero-tuple to `null` before
 * recovering the sender and computing the fee payer sign payload.
 */
export async function cosignFeePayer(
  serializedTransaction: TxEnvelopeTempo.Serialized,
  feePayer: Account,
): Promise<TxEnvelopeTempo.Serialized> {
  const envelope = TxEnvelopeTempo.deserialize(serializedTransaction)

  // Normalize zero-tuple fee payer placeholder → null sentinel.
  //
  // The Tempo transaction spec defines the placeholder as
  // `Some(Signature::default())`, which RLP-encodes to a list of zeros
  // `[0x80, 0x80, 0x80]` (= `c3 80 80 80`). This is the encoding that
  // Rust/alloy produces. However, ox's `deserialize` only recognises its
  // own `0x00` sentinel and falls through to `Signature.fromTuple`,
  // yielding `{ r: 0n, s: 0n, yParity: 0 }` — a real signature object
  // instead of `null`.
  //
  // When `getSignPayload` later serialises the envelope for the sender
  // hash, `null` produces `0x00` (1 byte) matching Rust's `encode_for_signing`,
  // but the zero-tuple object produces the full RLP list (4 bytes),
  // causing sender recovery and fee payer signing to fail.
  //
  // A zero-valued ECDSA signature (r=0, s=0) is cryptographically
  // impossible, so this normalisation is always safe.
  //
  // TODO: Fix upstream in ox's `TxEnvelopeTempo.deserialize` to recognise
  // the zero-tuple as a placeholder (https://github.com/wevm/ox/issues/174).
  if (
    envelope.feePayerSignature &&
    envelope.feePayerSignature.r === 0n &&
    envelope.feePayerSignature.s === 0n
  ) {
    envelope.feePayerSignature = null
  }

  // Recover sender from the user's signature
  const sender = (() => {
    const sig = envelope.signature
    if (!sig) throw new Error('Transaction has no signature')
    if (sig.type === 'secp256k1')
      return Secp256k1.recoverAddress({
        payload: TxEnvelopeTempo.getSignPayload(envelope),
        signature: sig.signature,
      })
    if (sig.type === 'keychain') return sig.userAddress
    if (sig.type === 'p256' || sig.type === 'webAuthn')
      return OxAddress.fromPublicKey(sig.publicKey)
    throw new Error(`Unsupported signature type: ${(sig as { type: string }).type}`)
  })()

  // Compute fee payer sign payload and sign with fee payer account
  const feePayerHash = TxEnvelopeTempo.getFeePayerSignPayload(envelope, {
    sender: sender as `0x${string}`,
  })
  const feePayerSig = await feePayer.sign!({ hash: feePayerHash })

  // Re-serialize with the real fee payer signature
  return TxEnvelopeTempo.serialize(envelope, {
    feePayerSignature: OxSignature.from(feePayerSig),
  })
}
