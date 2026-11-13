import { Algorithms } from '../Constants.js'
import type { SignatureAlgorithm, Signer, SigningKey } from '../Types.js'

/** Byte length of every Ed25519 signature. */
const ed25519SignatureLength = 64

/**
 * Whether `key` is an external {@link Signer} rather than a `CryptoKey`.
 * @internal
 */
export function isSigner(key: SigningKey): key is Signer {
  return (
    typeof key === 'object' &&
    key !== null &&
    typeof (key as { sign?: unknown }).sign === 'function'
  )
}

/**
 * Calls an external signer and checks its result is a raw signature for `algorithm`.
 *
 * Gives the signer its own copy of `bytes` and returns a copy of the signature, so neither side
 * can change the other's buffer afterwards.
 * @internal
 */
export async function sign(
  signer: Signer,
  algorithm: SignatureAlgorithm,
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const signature: unknown = await signer.sign(Uint8Array.from(bytes))
  if (!(signature instanceof Uint8Array))
    throw new TypeError('External signer must resolve with the raw signature as a Uint8Array.')
  if (algorithm === Algorithms.ed25519 && signature.byteLength !== ed25519SignatureLength)
    throw new TypeError(
      `External Ed25519 signer returned ${signature.byteLength} bytes; an Ed25519 signature is ${ed25519SignatureLength} bytes.`,
    )
  if (signature.byteLength === 0)
    throw new TypeError('External signer returned an empty signature.')
  return Uint8Array.from(signature)
}
