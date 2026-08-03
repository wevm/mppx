import type { MaybePromise } from '../internal/types.js'
import type { Algorithms } from './Constants.js'

/** RFC 9421 algorithms implemented by the request-attestation signer and verifier. */
export type SignatureAlgorithm = (typeof Algorithms)[keyof typeof Algorithms]

/** Resolves a trusted public key for a parsed request signature. */
export type KeyResolver = (parameters: {
  /** RFC 9421 algorithm declared by the signature. */
  algorithm: SignatureAlgorithm
  /** Key identifier declared by the signature. */
  keyId: string
  /** Request carrying the signature. */
  request: Request
}) => MaybePromise<CryptoKey | undefined>

/**
 * The complete outcome of attempting one protocol verifier.
 *
 * `absent` means the protocol did not appear on the request. `invalid` means
 * it appeared but failed validation and must reject the request. `unverified`
 * means key material or another required verification dependency was unavailable.
 * `verified` carries protocol-specific data that is safe for callers to inspect.
 */
export type Verification<value = unknown> =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'unverified'; reason: string }
  | { status: 'verified'; value: value }

/**
 * Verifies one request-attestation protocol carried by an HTTP request.
 *
 * Verifiers are registered in a {@link VerifierMap}; each map key names the
 * result returned to the caller.
 */
export type Verifier<value = unknown> = {
  /** Validates the request and returns a complete protocol verification outcome. */
  verify: (request: Request) => MaybePromise<Verification<value>>
}

/** Maps each recognized protocol name to its verifier. */
export type VerifierMap = Readonly<Record<string, Verifier>>

/** Preserves each configured protocol's complete verification outcome. */
export type VerificationsFrom<verifiers extends VerifierMap> = {
  readonly [protocol in keyof verifiers]: Awaited<ReturnType<verifiers[protocol]['verify']>>
}

/**
 * Values shared by every signer contributing to one HTTP request attempt.
 *
 * A caller may reuse this context across independent signature protocols so
 * they describe the same attempt. A later network retry must use a new context.
 */
export type SigningContext = {
  /** Unix timestamp, in seconds, at which the request attempt was created. */
  readonly created: number
  /** Base64url-encoded random value identifying this request attempt. */
  readonly nonce: string
}

/**
 * Signs each outbound HTTP request, including MPP payment retries.
 *
 * The protocol type preserves which adapter produced the signer for diagnostics
 * and composition, without asserting that the signer alone authorizes payment.
 */
export type Signer<protocol extends string = string> = {
  /** Protocol identifier used for diagnostics. */
  protocol: protocol
  /** Returns a new request containing the protocol's signature material. */
  sign: (request: Request, context?: SigningContext | undefined) => MaybePromise<Request>
}
