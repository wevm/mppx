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

  const inScope = (url: string) => {
    const origin = new URL(url).origin
    return provers.filter((prover) => prover.scope === '*' || prover.scope.includes(origin))
  }

  async function sendOnce(
    fetch: typeof globalThis.fetch,
    request: Request,
    context: Types.Context,
  ): Promise<{ request: Request; response: Response }> {
    const scoped = inScope(request.url)
    if (scoped.length === 0) return { request, response: await fetch(request.clone()) }
    const attempt: Types.ProveContext = Object.freeze({ ...context, ...SigningContext.create() })
    let sent = new Request(request.clone(), {
      redirect: request.redirect === 'follow' ? 'error' : request.redirect,
    })
    for (const prover of scoped) sent = await prover.prove(sent, attempt)
    return { request: sent, response: await fetch(sent) }
  }

  return {
    async send(fetch, request, context = {}) {
      const result = await sendOnce(fetch, request, context)
      const { response } = result
      // A paid attempt (context carries the challenge) is never resent: its credential may
      // already have settled, and replaying it could trigger another payment.
      if (context.challenge || response.status < 400 || response.status === 402) return result
      // Each callback reads its own copy, so the returned response stays readable.
      const copies: Response[] = []
      let retry = false
      for (const prover of inScope(request.url)) {
        if (!prover.retry) continue
        const copy = response.clone()
        copies.push(copy)
        if (await prover.retry(copy, context)) retry = true
      }
      if (!retry) return result
      // Release every unread branch without waiting, so an unread copy cannot block the resend.
      for (const unread of [response, ...copies])
        if (!unread.bodyUsed) void unread.body?.cancel().catch(() => {})
      return sendOnce(fetch, request, context)
    },
    async challenge(response, context, url) {
      for (const prover of inScope(url)) await prover.retry?.(response.clone(), context)
    },
  }
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
  return async (input, init) =>
    (await client.send(fetch, new Request(input, init), context)).response
}
