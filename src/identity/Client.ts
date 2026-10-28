import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as SigningContext from './internal/SigningContext.js'
import type * as Types from './Types.js'

/** Sends HTTP attempts with every in-scope prover applied. */
export type Client = {
  /**
   * Proves and sends one request.
   *
   * Requests that carry proofs do not follow redirects: a redirect rejects
   * (`redirect: 'error'`), so proofs never reach another URL. Requests with no
   * prover in scope are sent unchanged. If a prover asks to retry a rejected
   * (non-402) response, the request is proved again and resent once, except for
   * paid attempts, which are never resent.
   */
  send: (
    fetch: typeof globalThis.fetch,
    request: Request,
    context?: Types.Context,
  ) => Promise<{ request: Request; response: Response }>
  /** Lets in-scope provers prepare proofs for a 402 challenge from `url` before the payment retry. */
  challenge: (response: Response, context: Types.Context, url: string) => Promise<void>
}

/**
 * Creates the client runner for a list of provers.
 *
 * Provers run in list order on every attempt, sharing one attempt context.
 * List request signers last so their signatures cover headers added by
 * earlier provers.
 */
export function from(provers: readonly Types.Prover[]): Client {
  if (provers.length === 0)
    throw new TypeError('Mppx client identity must configure at least one prover.')

  // Scopes are matched exactly: a string scope would fall back to substring matching.
  for (const prover of provers)
    if (prover.scope !== '*' && !Array.isArray(prover.scope))
      throw new TypeError('Identity prover scope must be "*" or an array of origins.')

  const inScope = (url: string) => {
    const origin = new URL(url).origin
    return provers.filter((prover) => prover.scope === '*' || prover.scope.includes(origin))
  }

  async function sendOnce(
    fetch: typeof globalThis.fetch,
    request: Request,
    context: Types.Context,
    resendable: boolean,
  ): Promise<{ request: Request; response: Response }> {
    // Keep the original readable only when it may be resent; otherwise a clone would tee
    // (and buffer) a streamed body that is never read again.
    const source = resendable ? request.clone() : request
    const scoped = inScope(request.url)
    if (scoped.length === 0) return { request: source, response: await fetch(source) }
    const attempt: Types.ProveContext = Object.freeze({ ...context, ...SigningContext.create() })
    let sent = new Request(source, {
      redirect: request.redirect === 'follow' ? 'error' : request.redirect,
    })
    for (const prover of scoped) sent = await prover.prove(sent, attempt)
    return { request: sent, response: await fetch(sent) }
  }

  return {
    async send(fetch, request, context = {}) {
      // A paid attempt (a challenge in context, or a Payment credential the caller attached) is
      // never resent: its credential may already have settled, and replaying it could pay again.
      const paid =
        context.challenge !== undefined ||
        [...request.headers.values()].some(
          (value) => Credential.extractPaymentScheme(value) !== null,
        )
      const resendable = !paid && inScope(request.url).some((prover) => prover.retry)
      const result = await sendOnce(fetch, request, context, resendable)
      const { response } = result
      if (!resendable || response.status < 400 || response.status === 402) return result
      // Each callback reads its own copy, so the returned response stays readable.
      const copies: Response[] = []
      let retry = false
      for (const prover of inScope(request.url)) {
        if (!prover.retry) continue
        const copy = response.clone()
        copies.push(copy)
        if (await prover.retry(copy, context)) retry = true
      }
      if (!retry) {
        release(copies)
        return result
      }
      release([response, ...copies])
      return sendOnce(fetch, request, context, false)
    },
    async challenge(response, context, url) {
      for (const prover of inScope(url)) {
        if (!prover.retry) continue
        const copy = response.clone()
        try {
          await prover.retry(copy, context)
        } finally {
          release([copy])
        }
      }
    },
  }
}

/** Releases unread response copies without waiting, so they neither buffer the body nor block a resend. */
function release(responses: readonly Response[]) {
  for (const unread of responses) if (!unread.bodyUsed) void unread.body?.cancel().catch(() => {})
}

/**
 * Wraps a fetch implementation so every request is proved.
 *
 * Prefer `Mppx.create({ identity })`, which also passes the payment challenge to provers.
 */
export function wrapFetch(
  fetch: typeof globalThis.fetch,
  client: Client,
  context?: Types.Context,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    // A retry may answer a refreshed challenge: bind proofs to the challenge its credential
    // carries, and let provers prepare for a refreshed 402 of the same method and intent.
    const challenge = credentialChallenge(request.headers) ?? context?.challenge
    const { response } = await client.send(fetch, request, { ...context, challenge })
    if (response.status === 402 && challenge)
      for (const next of Challenge.fromResponseList(response))
        if (next.method === challenge.method && next.intent === challenge.intent)
          await client.challenge(response, { ...context, challenge: next }, request.url)
    return response
  }
}

/** Returns the challenge of a Payment credential in `headers`, if any. */
function credentialChallenge(headers: Headers): Challenge.Challenge | undefined {
  for (const [, value] of headers) {
    const payment = Credential.extractPaymentScheme(value)
    if (!payment) continue
    try {
      return Credential.deserialize(payment).challenge
    } catch {}
  }
  return undefined
}
