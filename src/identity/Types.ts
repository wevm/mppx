import type * as Challenge from '../Challenge.js'
import type * as Credential from '../Credential.js'
import type { MaybePromise } from '../internal/types.js'

/**
 * When a verifier runs on the server.
 *
 * `request` verifiers run before any payment challenge is issued and reject
 * the request with their own status code. `payment` verifiers run when a
 * challenge is issued (to add their own challenge headers to the 402) and
 * again on the paid retry, before the credential is settled.
 */
export type Stage = 'request' | 'payment'

/**
 * Payment state passed to verifiers and provers.
 *
 * Request-stage verifiers receive an empty context. Payment-stage verifiers
 * receive the challenge being issued, or the challenge and credential being
 * answered on the paid retry.
 */
export type Context = {
  /** The MPP challenge being issued or answered. */
  challenge?: Challenge.Challenge | undefined
  /** The payment credential submitted with the request. */
  credential?: Credential.Credential | undefined
}

/**
 * The outcome of one identity verifier.
 *
 * `missing` means the identity proof was not presented; its `headers` (for
 * example a protocol challenge) are returned to the client. `invalid` means a
 * proof was presented but must be rejected. `valid` carries the verified value.
 */
export type Verification<value = unknown> =
  | {
      status: 'missing'
      /** HTTP status for a request-stage rejection. @default 403 */
      code?: number | undefined
      /** Headers returned to the client, such as a protocol challenge. */
      headers?: HeadersInit | undefined
      /** Human-readable reason. */
      reason?: string | undefined
    }
  | {
      status: 'invalid'
      /** HTTP status for a request-stage rejection. @default 401 */
      code?: number | undefined
      /** Headers returned to the client, such as a protocol error object. */
      headers?: HeadersInit | undefined
      /** Human-readable reason. */
      reason: string
    }
  | { status: 'valid'; value: value }

/** Verifies one identity protocol on the server. */
export type Verifier<value = unknown> = {
  /** When the verifier runs. @default 'request' */
  stage?: Stage | undefined
  /** Returns the protocol's verification outcome for the request. */
  verify: (request: Request, context: Context) => MaybePromise<Verification<value>>
}

/** Verified identity values, looked up by the verifier that produced them. */
export type Results = {
  /** Returns the verified value for a verifier, or `undefined` if it did not run or match. */
  get<value>(verifier: Verifier<value>): value | undefined
}

/**
 * Values shared by every prover contributing to one HTTP attempt.
 *
 * Every retry gets a new context, so single-use nonces are never replayed.
 */
export type ProveContext = Context & {
  /** Unix timestamp, in seconds, at which the attempt was created. */
  readonly created: number
  /** Base64url-encoded random value identifying the attempt. */
  readonly nonce: string
}

/** Adds one identity protocol to outbound requests on the client. */
export type Prover = {
  /** Origins the prover may run for, such as `['https://shop.example']`, or `'*'` for any origin. */
  scope: readonly string[] | '*'
  /** Returns a new request carrying the protocol's identity material. */
  prove: (request: Request, context: ProveContext) => MaybePromise<Request>
  /**
   * Inspects a rejected or 402 response and prepares a proof for the next attempt.
   *
   * Return `true` to resend a rejected (non-402) request once. On a 402 the
   * context carries the selected challenge and the payment retry always follows.
   */
  retry?: ((response: Response, context: Context) => MaybePromise<boolean | undefined>) | undefined
}
