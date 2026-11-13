import { Algorithms } from '../Constants.js'
import type { SignatureAlgorithm, SigningKey } from '../Types.js'

/** A {@link SigningKey} checked and ready to sign. */
export type Resolved = {
  /** Signature algorithm, from the public key. */
  readonly algorithm: SignatureAlgorithm
  /** Public key that verifies every signature. */
  readonly publicKey: CryptoKey
  /** Signs the complete message and resolves with the raw signature. */
  readonly sign: (payload: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>
}

const webCrypto = {
  [Algorithms.ed25519]: { name: 'Ed25519' },
  [Algorithms.rsaPssSha512]: { name: 'RSA-PSS', saltLength: 64 },
} as const satisfies Record<SignatureAlgorithm, AlgorithmIdentifier | RsaPssParams>

/**
 * Checks a {@link SigningKey} and returns how to sign with it.
 *
 * Throws a `TypeError` unless the key is a `CryptoKeyPair` or a {@link Signer} whose public key
 * is one of `algorithms`. A `Signer`'s signatures are verified against its public key before
 * they are returned.
 * @internal
 */
export function resolve(
  key: SigningKey,
  algorithms: readonly SignatureAlgorithm[] = Object.values(Algorithms),
): Resolved {
  if (!isObject(key)) throw invalidKey()
  const { publicKey } = key as { publicKey?: unknown }
  if (isCryptoKey(key))
    throw new TypeError(
      'Signing keys are key pairs: pass { privateKey, publicKey } or a Signer, not a private key alone.',
    )
  if (!isCryptoKey(publicKey) || publicKey.type !== 'public') throw invalidKey()
  const algorithm = algorithmOf(publicKey)
  if (!algorithm || !algorithms.includes(algorithm))
    throw new TypeError(`Signing keys must be ${describe(algorithms)}.`)
  const parameters = webCrypto[algorithm]

  if (typeof (key as { sign?: unknown }).sign === 'function') {
    const signer = key as Extract<SigningKey, { sign: unknown }>
    if (!publicKey.usages.includes('verify'))
      throw new TypeError('A Signer publicKey must have the verify usage.')
    return {
      algorithm,
      publicKey,
      async sign(payload) {
        const signature: unknown = await signer.sign({ payload: Uint8Array.from(payload) })
        if (!isUint8Array(signature))
          throw new TypeError('A Signer must resolve with the raw signature as a Uint8Array.')
        // A copy, so the signer can't change the signature after it is checked.
        const bytes = Uint8Array.from(signature)
        let valid = false
        try {
          valid = await crypto.subtle.verify(parameters, publicKey, bytes, Uint8Array.from(payload))
        } catch {}
        if (!valid)
          throw new Error(
            'The Signer returned a signature that does not verify with its publicKey. Check that it signs the payload itself (not a digest) with that key, and returns raw signature bytes.',
          )
        return bytes
      },
    }
  }

  const { privateKey } = key as { privateKey?: unknown }
  if (!isCryptoKey(privateKey) || privateKey.type !== 'private') throw invalidKey()
  if (algorithmOf(privateKey) !== algorithm)
    throw new TypeError(
      'The privateKey and publicKey of a signing key pair use different algorithms.',
    )
  return {
    algorithm,
    publicKey,
    async sign(payload) {
      return new Uint8Array(
        await crypto.subtle.sign(parameters, privateKey, Uint8Array.from(payload)),
      )
    },
  }
}

/** The signature algorithm a key is for, or `undefined` when it is not supported. */
function algorithmOf(key: CryptoKey): SignatureAlgorithm | undefined {
  if (key.algorithm.name === 'Ed25519') return Algorithms.ed25519
  if (
    key.algorithm.name === 'RSA-PSS' &&
    (key.algorithm as RsaHashedKeyAlgorithm).hash?.name === 'SHA-512'
  )
    return Algorithms.rsaPssSha512
  return undefined
}

function describe(algorithms: readonly SignatureAlgorithm[]): string {
  return algorithms
    .map((algorithm) => (algorithm === Algorithms.ed25519 ? 'Ed25519' : 'RSA-PSS SHA-512'))
    .join(' or ')
}

function invalidKey() {
  return new TypeError('A signing key must be a CryptoKeyPair or a Signer with publicKey and sign.')
}

/** Whether `value` is a `Uint8Array` (or `Buffer`), including one from another realm. */
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function isCryptoKey(value: unknown): value is CryptoKey {
  // Duck-typed so keys from another realm or a WebCrypto polyfill keep working.
  return (
    isObject(value) &&
    typeof (value as { type?: unknown }).type === 'string' &&
    isObject((value as { algorithm?: unknown }).algorithm) &&
    Array.isArray((value as { usages?: unknown }).usages)
  )
}
