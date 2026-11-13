import type { MaybePromise } from '../../internal/types.js'
import type { Algorithms } from './Constants.js'

/** RFC 9421 algorithms implemented by the HTTP message signature signer and verifier. */
export type SignatureAlgorithm = (typeof Algorithms)[keyof typeof Algorithms]

/**
 * Signs with a private key held outside this process, such as in a cloud KMS, an HSM or a
 * wallet service like Turnkey, so the key never has to be exported as a `CryptoKey`.
 */
export type Signer<algorithm extends SignatureAlgorithm = SignatureAlgorithm> = {
  /** Algorithm of the remote key. */
  readonly algorithm: algorithm
  /**
   * Signs `bytes` (the complete message to sign: the UTF-8 RFC 9421 signature base, or the
   * JWS signing input) and resolves with the raw signature bytes: 64 bytes for Ed25519, or the
   * RSA modulus length for RSA-PSS SHA-512 (SHA-512 digest, MGF1 with SHA-512, 64-byte salt).
   * Not DER, hex or base64. The signer must hash `bytes` itself: they are not a digest.
   */
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

/** A local private key, or a {@link Signer} whose private key stays elsewhere. */
export type SigningKey<algorithm extends SignatureAlgorithm = SignatureAlgorithm> =
  | CryptoKey
  | Signer<algorithm>

/** Resolves a trusted public key for a parsed request signature. */
export type KeyResolver = (parameters: {
  /** RFC 9421 algorithm declared by the signature. */
  algorithm: SignatureAlgorithm
  /** Key identifier declared by the signature. */
  keyId: string
  /** Request carrying the signature. */
  request: Request
}) => MaybePromise<CryptoKey | undefined>

/** Values shared by every signature on one HTTP attempt. */
export type SigningContext = {
  /** Unix timestamp, in seconds, at which the attempt was created. */
  readonly created: number
  /** Base64url-encoded random value identifying the attempt. */
  readonly nonce: string
}
