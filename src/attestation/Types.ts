import type { MaybePromise } from '../internal/types.js'
import type { Algorithms, Capabilities } from './Constants.js'

/**
 * A verified statement about an HTTP request.
 *
 * `protocol` is the protocol that issued it, `capabilities` states exactly what
 * that protocol proved, and `value` contains only protocol-specific verified
 * data. Policies must rely on capabilities, not an unverified request header.
 */
export type Evidence<protocol extends string = string, value = unknown> = {
  /** Protocol identifier that issued this evidence. */
  protocol: protocol
  /** Properties cryptographically established for this request. */
  capabilities: readonly Capability[]
  /** Protocol-specific data extracted only after verification succeeds. */
  value: value
}

/** Assertions a policy can require before permitting an automated request. */
export type Capability = (typeof Capabilities)[keyof typeof Capabilities]

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
 * `verified` carries evidence that is safe for authorization policy to inspect.
 */
export type Verification<evidence extends Evidence = Evidence> =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'unverified'; reason: string }
  | { status: 'verified'; evidence: evidence }

/**
 * Verifies one protocol's evidence carried by an HTTP request.
 *
 * Verifiers are registered in a {@link VerifierMap}; the map key names the
 * protocol in error reporting while the evidence type flows into the policy.
 */
export type Verifier<evidence extends Evidence = Evidence> = {
  /** Validates the request and returns a complete protocol verification outcome. */
  verify: (request: Request) => MaybePromise<Verification<evidence>>
}

/** Maps each recognized protocol name to its verifier. */
export type VerifierMap = Readonly<Record<string, Verifier>>

/** Extracts the verified-evidence union from a registered verifier map. */
export type EvidenceFrom<verifiers extends VerifierMap> = {
  [protocol in keyof verifiers]: verifiers[protocol] extends Verifier<infer evidence>
    ? evidence
    : never
}[keyof verifiers]

/** Preserves each configured protocol's complete verification outcome. */
export type VerificationsFrom<verifiers extends VerifierMap> = {
  readonly [protocol in keyof verifiers]: Awaited<ReturnType<verifiers[protocol]['verify']>>
}

/** Evidence and protocol outcomes produced while verifying one request. */
export type VerificationSummary<verifiers extends VerifierMap = VerifierMap> = {
  evidence: readonly EvidenceFrom<verifiers>[]
  outcomes: VerificationsFrom<verifiers>
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

/** A policy decision made after request-attestation verification. */
export type PolicyResult = { allow: true } | { allow: false; reason: string }

/**
 * Decides whether request verification outcomes and evidence are sufficient to continue.
 *
 * The generic evidence parameter lets a middleware configuration expose the
 * precise union produced by its verifier map to the policy implementation.
 */
export type RequestPolicy<
  evidence extends Evidence = Evidence,
  outcomes = Readonly<Record<string, Verification>>,
> = (input: {
  evidence: readonly evidence[]
  outcomes: outcomes
  request: Request
}) => MaybePromise<PolicyResult>

/** An HTTP handler that may resolve its response asynchronously. */
export type RequestHandler = (request: Request) => MaybePromise<Response>
