import type * as Types from './Types.js'

const members = Symbol('mppx.identity.members')

type AnyOfVerifier = Types.Verifier<{ index: number; value: unknown }> & {
  readonly [members]: readonly Types.Verifier[]
}

/**
 * Accepts the first of several identity protocols that verifies.
 *
 * Every member runs. The result is `valid` if any member verifies, `invalid` if none verifies and
 * any member was presented but failed, and `missing` otherwise, with every
 * member's challenge headers. All members must run at the same stage.
 *
 * @example
 * ```ts
 * mppx.charge({ amount: '1', identity: [Identity.anyOf(tap, webBotAuth)] })
 * ```
 */
export function anyOf(
  ...verifiers: readonly [Types.Verifier, Types.Verifier, ...Types.Verifier[]]
): Types.Verifier<{ index: number; value: unknown }> {
  const stage = stageOf(verifiers[0])
  if (verifiers.some((verifier) => stageOf(verifier) !== stage))
    throw new TypeError('Identity anyOf verifiers must run at the same stage.')
  const verifier: AnyOfVerifier = {
    [members]: verifiers,
    stage,
    async verify(request, context) {
      // Every member runs, so each presented proof's replay nonce is consumed even when an
      // earlier member already verified; the first valid member wins.
      const all = []
      for (const member of verifiers) all.push(await run(member, request, context))
      const index = all.findIndex((outcome) => outcome.status === 'valid')
      const matched = all[index]
      if (matched?.status === 'valid')
        return { status: 'valid', value: { index, value: matched.value } }
      const outcomes = all as Exclude<Types.Verification, { status: 'valid' }>[]
      const headers = mergeHeaders(outcomes)
      const invalid = outcomes.find((outcome) => outcome.status === 'invalid')
      if (invalid) return { status: 'invalid', code: invalid.code, headers, reason: invalid.reason }
      // Keep the first member's custom status so wrapping a verifier does not change its HTTP behavior.
      const code = outcomes.find((outcome) => outcome.code !== undefined)?.code
      return {
        status: 'missing',
        ...(code !== undefined && { code }),
        headers,
        reason: 'None of the accepted identity proofs was presented.',
      }
    },
  }
  return verifier
}

/** The combined outcome of a route's verifiers at one stage. @internal */
export type Outcome =
  | { status: 'valid'; values: ReadonlyMap<Types.Verifier, unknown> }
  | { status: 'missing' | 'invalid'; code: number; headers: Headers; reason: string }

/**
 * Runs every verifier at one stage and combines their outcomes.
 *
 * Every verifier must be valid. Any `invalid` outcome rejects with 401 unless
 * it sets its own code; otherwise any `missing` outcome rejects with 403. The
 * headers of every rejected outcome are merged. Each verifier runs at most once
 * per request and context, so replay-protected nonces are consumed once even
 * when several handlers evaluate the same request.
 */
export async function verify(
  request: Request,
  verifiers: readonly Types.Verifier[],
  context: Types.Context = {},
): Promise<Outcome> {
  const values = new Map<Types.Verifier, unknown>()
  const rejected: Exclude<Types.Verification, { status: 'valid' }>[] = []
  for (const verifier of verifiers) {
    const outcome = await run(verifier, request, context)
    if (outcome.status !== 'valid') {
      rejected.push(outcome)
      continue
    }
    // Record the matched member at every anyOf level, so results.get(leaf) works when nested.
    let current: Types.Verifier = verifier
    let value: unknown = outcome.value
    for (;;) {
      values.set(current, value)
      const nested = (current as Partial<AnyOfVerifier>)[members]
      if (!nested) break
      const matched = value as { index: number; value: unknown }
      current = nested[matched.index]!
      value = matched.value
    }
  }
  if (rejected.length === 0) return { status: 'valid', values }
  const headers = mergeHeaders(rejected)
  const invalid = rejected.find((outcome) => outcome.status === 'invalid')
  if (invalid)
    return { status: 'invalid', code: invalid.code ?? 401, headers, reason: invalid.reason }
  const missing = rejected[0]!
  return {
    status: 'missing',
    code: missing.code ?? 403,
    headers,
    reason: missing.reason ?? 'Identity verification is required.',
  }
}

/** Builds the rejection response for a failed request-stage outcome. @internal */
export function toResponse(outcome: Exclude<Outcome, { status: 'valid' }>): Response {
  const headers = new Headers(outcome.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(outcome.reason, { headers, status: outcome.code })
}

/** Creates a results lookup from verified values. @internal */
export function results(values: ReadonlyMap<Types.Verifier, unknown> = new Map()): Types.Results {
  return Object.freeze({
    get<value>(verifier: Types.Verifier<value>) {
      return values.get(verifier) as value | undefined
    },
  })
}

/** Returns the stage a verifier runs at. @internal */
export function stageOf(verifier: Types.Verifier): Types.Stage {
  const stage = verifier.stage ?? 'request'
  // An unknown stage would leave the verifier unchecked, so it is rejected (fail closed).
  if (stage !== 'request' && stage !== 'payment')
    throw new TypeError(`Unknown identity verifier stage "${String(stage)}".`)
  return stage
}

const cache = new WeakMap<
  Request,
  Map<Types.Verifier, Map<string, Map<unknown, Promise<Types.Verification>>>>
>()

function run(
  verifier: Types.Verifier,
  request: Request,
  context: Types.Context,
): Promise<Types.Verification> {
  let byVerifier = cache.get(request)
  if (!byVerifier) cache.set(request, (byVerifier = new Map()))
  let byContext = byVerifier.get(verifier)
  if (!byContext) byVerifier.set(verifier, (byContext = new Map()))
  // Decisions can depend on the credential, so each credential object gets its own entry.
  const key = context.challenge?.id ?? ''
  let byCredential = byContext.get(key)
  if (!byCredential) byContext.set(key, (byCredential = new Map()))
  let outcome = byCredential.get(context.credential)
  if (!outcome) {
    outcome = Promise.resolve(verifier.verify(request, context))
    byCredential.set(context.credential, outcome)
  }
  return outcome
}

function mergeHeaders(outcomes: readonly Types.Verification[]): Headers {
  const merged = new Headers()
  for (const outcome of outcomes) {
    if (outcome.status === 'valid' || !outcome.headers) continue
    for (const [name, value] of new Headers(outcome.headers)) merged.append(name, value)
  }
  return merged
}
