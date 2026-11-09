import type * as AcceptPayment from '../../internal/AcceptPayment.js'
import type { MaybePromise } from '../../internal/types.js'
import type * as Method from '../../Method.js'

/** Inputs for a client method's own candidate ordering. */
export type HandlerParameters = {
  /** The supported candidates this method signs, in the current preference order. */
  candidates: readonly AcceptPayment.ChallengeCandidate[]
  /** The caller's credential context, when known before selection. */
  context?: unknown
}

/** Returns the method's candidates in its preferred order. */
export type Handler = (
  parameters: HandlerParameters,
) => MaybePromise<readonly AcceptPayment.ChallengeCandidate[]>

const handlers = new WeakMap<Method.AnyClient, Handler>()

/** Registers how a client method orders its own offers, without changing the public method shape. */
export function register<const method extends Method.AnyClient>(
  method: method,
  handler: Handler,
): method {
  handlers.set(method, handler)
  return method
}

/**
 * Applies each registered method's ordering before the caller's `orderChallenges` hook. A method
 * only reorders the positions its own candidates hold, so preferences between methods stay as
 * they were. A handler result that is not a permutation of its candidates is ignored.
 */
export async function apply<candidate extends AcceptPayment.ChallengeCandidate>(
  candidates: readonly candidate[],
  context?: unknown,
): Promise<readonly candidate[]> {
  let ordered = candidates
  const seen = new Set<unknown>()
  for (const { method } of candidates) {
    if (seen.has(method)) continue
    seen.add(method)
    const handler = handlers.get(method as Method.AnyClient)
    if (!handler) continue
    const own = ordered.filter((candidate) => candidate.method === method)
    if (own.length < 2) continue
    const next = await handler({ candidates: own, context })
    if (
      next.length !== own.length ||
      !own.every((candidate) => next.includes(candidate)) ||
      new Set(next).size !== next.length
    )
      continue
    let index = 0
    ordered = ordered.map((candidate) =>
      candidate.method === method ? (next[index++] as candidate) : candidate,
    )
  }
  return ordered
}
