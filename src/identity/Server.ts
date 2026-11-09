import type * as Challenge from '../Challenge.js'
import type * as Credential from '../Credential.js'
import * as Requirements from './internal/Requirements.js'
import * as Status from './Status.js'
import type * as Types from './Types.js'

/**
 * The members of each verifier `anyOf` returned, keyed by that exact object, so a copy or a
 * derived verifier (spread, `Object.create`) is not taken for one and its own `verify` runs.
 */
const anyOfMembers = new WeakMap<Types.Verifier, readonly Types.Verifier[]>()

/** The value of an `anyOf` verifier: the index of the first valid member and its value. */
type AnyOfValue = { readonly index: number; readonly value: unknown }

type Rejected = Exclude<Types.Verification, { status: 'valid' }>

/**
 * Accepts the first of several identity protocols that verifies.
 *
 * Every member runs. The result is `valid` if any member verifies (the first valid member
 * wins). Otherwise the rejected member whose status has the highest precedence
 * (`Identity.Status.precedence`) decides the status and reason, with every member's headers.
 *
 * @example
 * ```ts
 * mppx.charge({ amount: '1', identity: [Identity.anyOf(tap, webBotAuth)] })
 * ```
 */
export function anyOf(
  ...verifiers: readonly [Types.Verifier, Types.Verifier, ...Types.Verifier[]]
): Types.Verifier<AnyOfValue> {
  for (const verifier of verifiers) assertRequestStage(verifier)
  const verifier: Types.Verifier<AnyOfValue> = Object.freeze({
    async verify(request) {
      // Every member runs, so each presented proof's replay nonce is consumed even when an
      // earlier member already verified.
      const outcomes: Types.Verification[] = []
      for (const member of verifiers) outcomes.push(await member.verify(request))
      return combineAnyOf(outcomes)
    },
  })
  anyOfMembers.set(verifier, Object.freeze([...verifiers]))
  return verifier
}

/**
 * Combines the outcomes of `anyOf` members: `valid` with the first valid member, otherwise
 * the precedence rule with merged headers.
 */
function combineAnyOf(outcomes: readonly Types.Verification[]): Types.Verification<AnyOfValue> {
  const index = outcomes.findIndex((outcome) => outcome.status === 'valid')
  const matched = outcomes[index]
  if (matched?.status === 'valid')
    return Object.freeze({
      status: 'valid',
      value: Object.freeze({ index, value: matched.value }),
    })
  const decision = decide(outcomes as readonly Rejected[])
  return toVerification(
    decision.status === 'missing'
      ? { ...decision, reason: 'None of the accepted identity proofs was presented.' }
      : decision,
  )
}

/** A rejected outcome reduced to its fixed status, the HTTP code it is sent with, headers and reason. */
export type Decision = {
  readonly status: Types.RejectionStatus
  /** HTTP status code: `Identity.Status.codes[status]`, unless a deprecated `code` overrides it. */
  readonly code: number
  readonly headers: readonly (readonly [name: string, value: string])[]
  readonly reason: string
}

/** Verified values, keyed by the verifier (every `anyOf` level included) or payment check. */
export type Values = ReadonlyMap<Types.Verifier | Types.PaymentCheck, unknown>

/** The combined outcome of verifiers or a payment check. @internal */
export type Outcome = { readonly status: 'valid'; readonly values: Values } | Decision

/** The outcome of no verifiers: valid, with no values. @internal */
export const none: Outcome = Object.freeze({ status: 'valid', values: new Map() })

const defaultReasons = {
  missing: 'Identity verification is required.',
  invalid: 'The identity proof is invalid.',
  forbidden: 'This identity is not allowed.',
  unavailable: 'Identity verification is unavailable.',
} as const satisfies Record<Types.RejectionStatus, string>

/**
 * Decides one rejection from rejected outcomes: the outcome whose fixed status has the highest
 * precedence decides status, code and reason (the first such outcome on ties), and the headers
 * of every outcome are merged. @internal
 */
export function decide(outcomes: readonly Rejected[]): Decision {
  if (outcomes.length === 0) throw new TypeError('An identity decision needs a rejected outcome.')
  const normalized = outcomes.map(normalize)
  const rank = (decision: Decision) => Status.precedence.indexOf(decision.status)
  const winner = normalized.reduce((best, next) => (rank(next) < rank(best) ? next : best))
  return Object.freeze({
    ...winner,
    headers: Object.freeze(normalized.flatMap((decision) => decision.headers)),
  })
}

/**
 * Maps a rejected outcome to its fixed status, honoring the deprecated `code`. Fails closed: an
 * unknown status is `invalid`, and a deprecated `code` that is not an HTTP error status is ignored.
 */
function normalize(outcome: Rejected): Decision {
  const known = Object.hasOwn(Status.codes, outcome.status)
  const raw = known && 'code' in outcome ? outcome.code : undefined
  const code = Number.isInteger(raw) && raw! >= 400 && raw! <= 599 ? raw : undefined
  const status: Types.RejectionStatus = !known
    ? 'invalid'
    : code === Status.codes.forbidden
      ? 'forbidden'
      : code === Status.codes.unavailable
        ? 'unavailable'
        : outcome.status
  return {
    status,
    code: code ?? Status.codes[status],
    headers: Object.freeze(
      [...new Headers(outcome.headers)].map(([name, value]) =>
        Object.freeze([name, value] as const),
      ),
    ),
    reason: known
      ? (outcome.reason ?? defaultReasons[status])
      : 'The identity verifier returned an unknown status.',
  }
}

/** Turns a decision back into a verification, keeping a non-default code. */
function toVerification(decision: Decision): Rejected {
  const headers = decision.headers.map(([name, value]): [string, string] => [name, value])
  const { code, reason, status } = decision
  if (status === 'forbidden' || status === 'unavailable')
    return Object.freeze({ status, headers, reason })
  return Object.freeze({
    status,
    ...(code !== Status.codes[status] && { code }),
    headers,
    reason,
  })
}

/**
 * The identity state of one request. Every verifier runs at most once per context, so
 * replay-protected nonces are consumed once even when `compose` calls several offers with
 * the same request. `compose` creates one and passes it to every offer it calls; a route
 * called directly creates its own. @internal
 */
export class Context {
  /** Verification promises by verifier. Internal and mutable; outcomes are frozen. */
  readonly verifications = new Map<Types.Verifier, Promise<Types.Verification>>()
  /**
   * Payment check promises by check, then by Challenge id and attempt (`paid` or `unpaid`), so
   * a check runs once per attempt even when `compose` calls the matched offer again.
   */
  readonly checks = new Map<Types.PaymentCheck, Map<string, Promise<Outcome>>>()
}

/** Creates the identity context of one request. @internal */
export function createContext(): Context {
  return new Context()
}

/** Returns `value` if it is an identity context, otherwise a new one. @internal */
export function contextOf(value: unknown): Context {
  return value instanceof Context ? value : createContext()
}

/** Runs one verifier, or each `anyOf` member, at most once per context. */
function evaluate(
  context: Context,
  request: Request,
  verifier: Types.Verifier,
): Promise<Types.Verification> {
  let outcome = context.verifications.get(verifier)
  if (outcome) return outcome
  const nested = anyOfMembers.get(verifier)
  outcome = nested
    ? (async () => {
        const outcomes: Types.Verification[] = []
        for (const member of nested) outcomes.push(await evaluate(context, request, member))
        return combineAnyOf(outcomes)
      })()
    : (async () => verifier.verify(request))()
  context.verifications.set(verifier, outcome)
  return outcome
}

/**
 * Runs request-stage verifiers and combines their outcomes.
 *
 * Valid only if every verifier is valid, with each value recorded at every `anyOf` level, so
 * `results.get(leaf)` works when nested. Otherwise the precedence rule of {@link decide}.
 * @internal
 */
export async function verify(
  context: Context,
  request: Request,
  verifiers: readonly Types.Verifier[],
): Promise<Outcome> {
  const values = new Map<Types.Verifier, unknown>()
  const rejected: Rejected[] = []
  for (const verifier of verifiers) {
    const outcome = await evaluate(context, request, verifier)
    if (outcome.status !== 'valid') {
      rejected.push(outcome)
      continue
    }
    let current: Types.Verifier = verifier
    let value: unknown = outcome.value
    for (;;) {
      values.set(current, value)
      const nested = anyOfMembers.get(current)
      if (!nested) break
      const matched = value as AnyOfValue
      current = nested[matched.index]!
      value = matched.value
    }
  }
  if (rejected.length > 0) return decide(rejected)
  return Object.freeze({ status: 'valid', values })
}

/**
 * Runs a payment check at most once per context, Challenge and attempt, and returns its
 * outcome. @internal
 */
export function check(
  context: Context,
  paymentCheck: Types.PaymentCheck,
  parameters: Parameters<Types.PaymentCheck['verify']>[0],
): Promise<Outcome> {
  const key = `${parameters.challenge.id}:${parameters.credential ? 'paid' : 'unpaid'}`
  const outcomes = context.checks.get(paymentCheck) ?? new Map<string, Promise<Outcome>>()
  context.checks.set(paymentCheck, outcomes)
  let outcome = outcomes.get(key)
  if (outcome) return outcome
  outcome = (async () => {
    const result = await paymentCheck.verify(Object.freeze({ ...parameters }))
    if (result.status !== 'valid') return decide([result])
    return Object.freeze({ status: 'valid', values: new Map([[paymentCheck, result.value]]) })
  })()
  outcomes.set(key, outcome)
  return outcome
}

/**
 * The identity state of one route call, as a state machine:
 *
 * - `request`: nothing checked yet.
 * - `identified`: request-stage verifiers passed; no payment decision yet.
 * - `payment`: the payment check runs for a Challenge, with the Credential on a paid retry
 *   or without one before `authorize`.
 * - `accepted`: the payment check passed (or the route has none): paid work may run.
 * - `challenged`: the route issued a 402 carrying `requirements`.
 * - `rejected`: identity was rejected; the response is sent as is, never a fresh 402.
 *
 * @internal
 */
export type State =
  | { readonly phase: 'request' }
  | { readonly phase: 'identified'; readonly values: Values }
  | {
      readonly phase: 'payment'
      readonly values: Values
      readonly challenge: Challenge.Challenge
      readonly credential: Credential.Credential | undefined
    }
  | { readonly phase: 'accepted'; readonly values: Values }
  | {
      readonly phase: 'challenged'
      readonly values: Values
      readonly requirements: readonly Types.Requirement[]
    }
  | {
      readonly phase: 'rejected'
      readonly rejection: Types.Rejection
      readonly code: number
      readonly headers: Decision['headers']
    }

/**
 * An input to {@link transition}. The caller runs verifiers and checks (the only I/O) and feeds
 * their outcomes in. @internal
 */
export type Event =
  /** Request-stage verifiers ran (`none` when the route has none). */
  | { readonly type: 'verified'; readonly outcome: Outcome }
  /** The payment check is about to run for `challenge`, with the paid retry's Credential if any. */
  | {
      readonly type: 'pay'
      readonly challenge: Challenge.Challenge
      readonly credential: Credential.Credential | undefined
    }
  /** The payment check ran (`none` when the route has none). */
  | { readonly type: 'checked'; readonly outcome: Outcome }
  /** The route issues a 402 carrying `requirements`. */
  | { readonly type: 'challenge'; readonly requirements: readonly Types.Requirement[] }

/** The state of a route call before identity runs. @internal */
export const initial: State = Object.freeze({ phase: 'request' })

/**
 * Returns the next identity state. Pure: it never runs verifiers, and it throws a `TypeError`
 * for an event the current phase does not accept.
 *
 * | Phase                    | Event                  | Next                              |
 * | ------------------------ | ---------------------- | --------------------------------- |
 * | `request`                | `verified` (valid)     | `identified`                      |
 * | `request`                | `verified` (rejected)  | `rejected` (stage `request`)      |
 * | `identified`             | `pay`                  | `payment`                         |
 * | `payment`                | `checked` (valid)      | `accepted`                        |
 * | `payment` + Credential   | `checked` (rejected)   | `rejected` (stage `payment`)      |
 * | `payment`, no Credential | `checked` (rejected)   | `identified` (not authorized)     |
 * | `identified`, `accepted` | `challenge`            | `challenged`                      |
 *
 * @internal
 */
export function transition(state: State, event: Event): State {
  switch (event.type) {
    case 'verified':
      if (state.phase !== 'request') break
      if (event.outcome.status !== 'valid') return reject('request', event.outcome)
      return Object.freeze({ phase: 'identified', values: event.outcome.values })
    case 'pay':
      if (state.phase !== 'identified') break
      return Object.freeze({
        phase: 'payment',
        values: state.values,
        challenge: event.challenge,
        credential: event.credential,
      })
    case 'checked':
      if (state.phase !== 'payment') break
      if (event.outcome.status === 'valid')
        return Object.freeze({
          phase: 'accepted',
          values: new Map([...state.values, ...event.outcome.values]),
        })
      // A paid retry may already have pushed the payment: reject instead of a fresh 402.
      if (state.credential) return reject('payment', event.outcome)
      return Object.freeze({ phase: 'identified', values: state.values })
    case 'challenge':
      if (state.phase !== 'identified' && state.phase !== 'accepted') break
      return Object.freeze({
        phase: 'challenged',
        values: state.values,
        requirements: event.requirements,
      })
  }
  throw new TypeError(`Illegal identity transition "${event.type}" from phase "${state.phase}".`)
}

function reject(stage: Types.Rejection['stage'], decision: Decision): State {
  return Object.freeze({
    phase: 'rejected',
    rejection: Object.freeze({ stage, status: decision.status, reason: decision.reason }),
    code: decision.code,
    headers: decision.headers,
  })
}

/** Builds the rejection response of a rejected state. @internal */
export function toResponse(state: Extract<State, { phase: 'rejected' }>): Response {
  const headers = new Headers(state.headers.map(([name, value]): [string, string] => [name, value]))
  headers.set('Cache-Control', 'no-store')
  return new Response(state.rejection.reason, { headers, status: state.code })
}

/** Returns the frozen results lookup of a state's verified values. @internal */
export function results(state: State): Types.Results {
  const values: Values = 'values' in state ? state.values : new Map()
  return Object.freeze({
    get<value>(verifier: Types.Verifier<value> | Types.PaymentCheck<value>) {
      return values.get(verifier) as value | undefined
    },
  })
}

/** A route's parsed `identity` option. @internal */
export type RouteConfig = {
  readonly request: readonly Types.Verifier[]
  readonly payment: Types.PaymentCheck | undefined
}

/**
 * Parses a route's `identity` option. Throws a `TypeError` for a payment-stage or unknown-stage
 * verifier, and for payment requirements that cannot be serialized. @internal
 */
export function route(identity: Types.Route | undefined): RouteConfig {
  const { payment = undefined, request = [] } = Array.isArray(identity)
    ? { request: identity as readonly Types.Verifier[] }
    : parseObject(identity)
  for (const verifier of request) assertRequestStage(verifier)
  // Any value but undefined is a payment check, so a falsy malformed one cannot turn it off.
  if (payment !== undefined) {
    if (typeof payment !== 'object' || payment === null)
      throw new TypeError('Identity payment check must be { requires, verify }.')
    if (!Array.isArray(payment.requires))
      throw new TypeError('Identity payment check must list the identities it requires.')
    if (typeof payment.verify !== 'function')
      throw new TypeError('Identity payment check must have a verify function.')
    Requirements.serialize(payment.requires)
  }
  return Object.freeze({ payment, request: Object.freeze([...request]) })
}

/**
 * Parses the object form `{ request?, payment? }`. Any other shape (a bare verifier, an `anyOf`
 * result, a misspelled key) throws, so a route never silently runs without its identity checks.
 */
function parseObject(
  identity: Types.Route | undefined,
): Exclude<Types.Route, readonly Types.Verifier[]> {
  if (identity === undefined) return {}
  if (typeof identity !== 'object' || identity === null)
    throw new TypeError('Route identity must be an array of verifiers or { request, payment }.')
  const keys = Object.keys(identity)
  const unknown = keys.filter((key) => key !== 'request' && key !== 'payment')
  if (unknown.length > 0 || 'verify' in identity)
    throw new TypeError(
      `Route identity must be an array of verifiers or { request, payment }; got ${
        unknown.length > 0 ? `key "${unknown[0]}"` : 'a verifier'
      }. Wrap a single verifier in an array.`,
    )
  const { request } = identity as Exclude<Types.Route, readonly Types.Verifier[]>
  if (request !== undefined && !Array.isArray(request))
    throw new TypeError('Route identity request must be an array of verifiers.')
  return identity as Exclude<Types.Route, readonly Types.Verifier[]>
}

/** Throws unless a verifier runs at the request stage (the only one). */
function assertRequestStage(verifier: Types.Verifier): void {
  const stage = verifier.stage ?? 'request'
  if (stage === 'payment')
    throw new TypeError(
      'Payment-stage identity verifiers were removed: pass a payment check as `identity: { payment }` instead.',
    )
  // An unknown stage would leave the verifier unchecked, so it is rejected (fail closed).
  if (stage !== 'request')
    throw new TypeError(`Unknown identity verifier stage "${String(stage)}".`)
}
