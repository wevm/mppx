import type * as Challenge from '../Challenge.js'
import type * as Credential from '../Credential.js'
import type { MaybePromise } from '../internal/types.js'

/**
 * When a verifier runs on the server.
 *
 * @deprecated Every verifier runs at the `request` stage. Use `identity: { payment }` with an
 * {@link PaymentCheck} for checks on the paid retry.
 */
export type Stage = 'request' | 'payment'

/**
 * The fixed status of a rejected identity outcome. Each maps to one HTTP status code
 * (`Identity.Status.codes`), and the highest in `Identity.Status.precedence` decides
 * when several verifiers reject.
 *
 * - `missing`: no proof was presented (401).
 * - `invalid`: a proof was presented but did not verify (401).
 * - `forbidden`: the proof verified, but the identity is not allowed (403).
 * - `unavailable`: the proof could not be checked right now, such as an issuer outage (503).
 */
export type RejectionStatus = 'missing' | 'invalid' | 'forbidden' | 'unavailable'

/**
 * The outcome of one identity verifier or payment check.
 *
 * `valid` carries the verified value. Every other status rejects the request with
 * its fixed HTTP status code; `headers` (such as a protocol challenge) are returned
 * to the client.
 */
export type Verification<value = unknown> =
  | { readonly status: 'valid'; readonly value: value }
  | {
      readonly status: 'missing'
      /**
       * HTTP status of the rejection.
       *
       * @deprecated Return `status: 'forbidden'` or `'unavailable'` instead. Still honored when set:
       * 403 maps to `forbidden`, 503 to `unavailable`, and any other code is sent as is.
       */
      readonly code?: number | undefined
      /** Headers returned to the client, such as a protocol challenge. */
      readonly headers?: HeadersInit | undefined
      /** Human-readable reason. */
      readonly reason?: string | undefined
    }
  | {
      readonly status: 'invalid'
      /**
       * HTTP status of the rejection.
       *
       * @deprecated Return `status: 'forbidden'` or `'unavailable'` instead. Still honored when set:
       * 403 maps to `forbidden`, 503 to `unavailable`, and any other code is sent as is.
       */
      readonly code?: number | undefined
      /** Headers returned to the client, such as a protocol error object. */
      readonly headers?: HeadersInit | undefined
      /** Human-readable reason. */
      readonly reason: string
    }
  | {
      readonly status: 'forbidden' | 'unavailable'
      /** Headers returned to the client. */
      readonly headers?: HeadersInit | undefined
      /** Human-readable reason. */
      readonly reason: string
    }

/** Verifies one identity protocol on the server, before any payment Challenge is issued. */
export type Verifier<value = unknown> = {
  /**
   * When the verifier runs.
   *
   * @deprecated Omit it. `'request'` is accepted; `'payment'` throws: use `identity: { payment }`.
   */
  readonly stage?: Stage | undefined
  /**
   * @deprecated Ignored. Payment-stage verifiers were replaced by `identity: { payment }`, whose
   * `requires` is sent in the 402's `Identity-Required` header.
   */
  readonly challenge?:
    | ((request: Request, context: { readonly nonce: string }) => unknown)
    | undefined
  /** Returns the protocol's verification outcome for the request. */
  readonly verify: (request: Request) => MaybePromise<Verification<value>>
}

/**
 * One identity a payment check requires, sent in the 402's `Identity-Required` header as a
 * structured-field list item: the `type` token with an `issuer` string parameter when set.
 *
 * @experimental Unstable: may change or be removed in any release.
 */
export type Requirement = {
  /** Identity type, a structured-field token such as `kyc`. */
  readonly type: string
  /** Issuer the identity must come from, such as `https://kyc.example`. */
  readonly issuer?: string | undefined
}

/**
 * Checks the payer's identity on the paid retry, before the Credential is settled.
 *
 * Every 402 the route issues carries `requires` in its `Identity-Required` header. `verify`
 * runs once on the paid retry with the answered Challenge and its Credential, after the
 * Credential's HMAC, pinned fields, expiry and payload are checked; any status other than
 * `valid` rejects with its fixed status code and no fresh 402, because the client may already
 * have pushed the payment. On a route with `authorize`, `verify` first runs without a
 * Credential, and only a `valid` result lets `authorize` run. x402 Credentials name no
 * Challenge the client could bind a proof to, so a route with a payment check rejects them as
 * `invalid` before settlement.
 *
 * @experimental Unstable: may change or be removed in any release.
 */
export type PaymentCheck<value = unknown> = {
  /** Identities the check requires, advertised in every 402 of the route. */
  readonly requires: readonly Requirement[]
  /** Returns the check's outcome for the paid retry (or, without a Credential, for `authorize`). */
  readonly verify: (parameters: {
    readonly request: Request
    readonly challenge: Challenge.Challenge
    readonly credential?: Credential.Credential | undefined
  }) => MaybePromise<Verification<value>>
}

/**
 * The `identity` option of an HTTP route.
 *
 * A list of request-stage verifiers, all of which must be valid, or an object with those
 * verifiers under `request` and an experimental payment check under `payment`.
 */
export type Route =
  | readonly Verifier[]
  | {
      /** Request-stage verifiers, all of which must be valid. */
      readonly request?: readonly Verifier[] | undefined
      /**
       * Identity check on the paid retry.
       *
       * @experimental Unstable: may change or be removed in any release.
       */
      readonly payment?: PaymentCheck | undefined
    }

/**
 * Why a route rejected a request's identity, returned as `rejection` on the result's
 * non-200 branch, whose `challenge` holds the rejection response to send as is.
 */
export type Rejection = {
  /** `request` for a request-stage verifier, `payment` for the payment check on the paid retry. */
  readonly stage: 'request' | 'payment'
  /** The deciding fixed status. */
  readonly status: RejectionStatus
  /** Human-readable reason, also the rejection response's body. */
  readonly reason: string
}

/** Verified identity values, looked up by the verifier or payment check that produced them. */
export type Results = {
  /** Returns the verified value for a verifier or payment check, or `undefined` if it did not run or match. */
  get<value>(verifier: Verifier<value> | PaymentCheck<value>): value | undefined
}

/**
 * Values shared by every prover contributing to one HTTP attempt.
 *
 * Every retry gets a new context, so single-use nonces are never replayed.
 */
export type ProveContext = {
  /** Unix timestamp, in seconds, at which the attempt was created (RFC 9421 `created`). */
  readonly created: number
  /** Base64url-encoded random value identifying the attempt (RFC 9421 `nonce`). */
  readonly nonce: string
  /** On a paid attempt, the Challenge being answered, so a proof can bind to its `id`. */
  readonly challenge?: Challenge.Challenge | undefined
}

/** Passed to {@link Prover.prepare} for a 402 before the payment retry. */
export type PrepareContext = {
  /** The Challenge the client selected; `prove` receives the same Challenge on the paid retry. */
  readonly challenge: Challenge.Challenge
  /**
   * The identities the 402's `Identity-Required` header lists.
   *
   * @experimental Unstable: may change or be removed in any release.
   */
  readonly requirements: readonly Requirement[]
}

/** Adds one identity protocol to outbound requests on the client. */
export type Prover = {
  /** Origins the prover may run for, such as `['https://shop.example']`, or `'*'` for any origin. */
  readonly scope: readonly string[] | '*'
  /** Returns a new request carrying the protocol's identity material. */
  readonly prove: (request: Request, context: ProveContext) => MaybePromise<Request>
  /** Prepares a proof from a 402 before the payment retry, such as for the identities it requires. */
  readonly prepare?:
    | ((response: Response, context: PrepareContext) => MaybePromise<void>)
    | undefined
  /**
   * Inspects a rejected (non-402) response and decides whether to resend the request once.
   *
   * Return headers to resend the request with: they are set on the request before every
   * in-scope prover proves it again, so signing provers cover them. Payment credential headers
   * (`Authorization`, `Payment-Signature`, `X-Payment`) are ignored. Return `false` or `undefined`
   * not to resend. Paid attempts are never resent. `true` resends with no extra headers and is
   * deprecated: return `{}` instead.
   */
  readonly retry?:
    | ((response: Response) => MaybePromise<HeadersInit | boolean | undefined>)
    | undefined
}
