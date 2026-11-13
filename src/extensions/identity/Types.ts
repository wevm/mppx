import type { MaybePromise } from '../../internal/types.js'
import type { Algorithms } from './Constants.js'

/** RFC 9421 algorithms implemented by the HTTP message signature signer and verifier. */
export type SignatureAlgorithm = (typeof Algorithms)[keyof typeof Algorithms]

/**
 * A key pair whose private key stays outside this process, such as in a cloud KMS, an HSM or a
 * wallet service like Turnkey.
 *
 * mppx checks every signature `sign` returns against `publicKey` before it uses it, so a wrong
 * key, a DER- or base64-encoded signature or a wrong RSA-PSS salt fails on the client instead of
 * at the server.
 */
export type Signer = {
  /**
   * The public key of the remote private key: Ed25519 or RSA-PSS SHA-512, with the `verify`
   * usage. Its algorithm is the signature algorithm, and identifiers that derive from the key
   * (such as a Web Bot Auth `keyid`) are computed from it.
   */
  readonly publicKey: CryptoKey
  /**
   * Signs `payload` (the complete message, not a digest: the RFC 9421 signature base or the JWS
   * signing input) and resolves with the raw signature bytes: 64 bytes for Ed25519, or the RSA
   * modulus length for RSA-PSS SHA-512 (SHA-512, MGF1 with SHA-512, 64-byte salt).
   */
  readonly sign: (parameters: { readonly payload: Uint8Array }) => Promise<Uint8Array>
}

/** A local `CryptoKeyPair`, or a {@link Signer} whose private key stays elsewhere. */
export type SigningKey = CryptoKeyPair | Signer

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
