import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Requirements from './internal/Requirements.js'
import * as SigningContext from './internal/SigningContext.js'
import type * as Types from './Types.js'

const skipPayment = Symbol.for('mppx.fetch.skipPayment')

/** Headers a prover's `retry` returned, as name and value pairs. */
export type ResendHeaders = readonly (readonly [name: string, value: string])[]

/** Payment state of one send. */
export type SendContext = {
  /** The Challenge a paid attempt answers. Its presence makes the attempt paid. */
  readonly challenge?: Challenge.Challenge | undefined
  /**
   * Headers a `retry` returned earlier in the same logical request, such as on the unpaid
   * attempt before a 402. They are set before the provers run, so the paid attempt carries them.
   */
  readonly headers?: ResendHeaders | undefined
}

/** Sends HTTP attempts with every in-scope prover applied. */
export type Client = {
  /**
   * Proves and sends one request.
   *
   * Requests that carry proofs do not follow redirects: a redirect rejects
   * (`redirect: 'error'`), so proofs never reach another URL. Requests with no
   * prover in scope are sent unchanged. If a prover asks to retry a rejected
   * (non-402) response, or answers the identity offer of an unpaid 402, the request
   * is proved again and resent once, except for paid attempts, which are never resent.
   */
  readonly send: (
    fetch: typeof globalThis.fetch,
    request: Request,
    context?: SendContext,
  ) => Promise<{
    request: Request
    response: Response
    /** The retry headers the last attempt carried, to pass on to the paid attempt. */
    headers: ResendHeaders
  }>
  /**
   * Lets in-scope provers prepare proofs for a 402 from `url` before the payment retry,
   * with the selected Challenge and the requirements of the 402's `Identity-Required` header.
   */
  readonly challenge: (
    response: Response,
    context: { readonly challenge: Challenge.Challenge },
    url: string,
  ) => Promise<void>
  /** Extra sensitive request headers the provers declare (`Prover.headers`), lowercased. */
  readonly headers: readonly string[]
}

/** x402 credential headers (v2 and v1); a request carrying one is a paid attempt. */
const x402CredentialHeaders = ['payment-signature', 'x-payment'] as const

/** Payment credential headers a prover's retry headers may never set, lowercased. */
const credentialHeaders: ReadonlySet<string> = new Set([
  'authorization',
  'payment-authorization',
  ...x402CredentialHeaders,
])

/**
 * The state of one `send`, as a state machine:
 *
 * - `unproved`: nothing sent yet.
 * - `sent`: an unpaid attempt was sent; it may be resent once.
 * - `paid`: a paid attempt was sent; it is never resent, since its payment may have settled.
 * - `resent`: the request is proved again and resent once, with `headers` set.
 * - `done`: the last response is final.
 *
 * @internal
 */
export type Attempt =
  | { readonly phase: 'unproved' }
  | { readonly phase: 'sent' }
  | { readonly phase: 'paid' }
  | { readonly phase: 'resent'; readonly headers: ResendHeaders }
  | { readonly phase: 'done' }

/** An input to {@link transition}. @internal */
export type AttemptEvent =
  /** The first attempt is sent, paid (a Challenge or payment credential) or not. */
  | { readonly type: 'send'; readonly payment: 'paid' | 'unpaid' }
  /** A response arrived; `resend` holds the headers provers asked to resend with, if any. */
  | { readonly type: 'response'; readonly resend: ResendHeaders | undefined }

/** The state of a `send` before anything is sent. @internal */
export const initial: Attempt = Object.freeze({ phase: 'unproved' })

/**
 * Returns the next attempt state. Pure; throws a `TypeError` for an event the current phase
 * does not accept, such as resending a paid attempt or resending twice.
 *
 * | Phase              | Event                  | Next       |
 * | ------------------ | ---------------------- | ---------- |
 * | `unproved`         | `send` (paid)          | `paid`     |
 * | `unproved`         | `send` (unpaid)        | `sent`     |
 * | `sent`             | `response` with resend | `resent`   |
 * | `sent`, `paid`, `resent` | `response` without   | `done`     |
 *
 * @internal
 */
export function transition(attempt: Attempt, event: AttemptEvent): Attempt {
  switch (event.type) {
    case 'send':
      if (attempt.phase !== 'unproved') break
      return Object.freeze({ phase: event.payment === 'paid' ? 'paid' : 'sent' })
    case 'response':
      if (event.resend === undefined) {
        if (attempt.phase === 'unproved' || attempt.phase === 'done') break
        return Object.freeze({ phase: 'done' })
      }
      if (attempt.phase !== 'sent') break
      return Object.freeze({ phase: 'resent', headers: event.resend })
  }
  const resend = event.type === 'response' && event.resend !== undefined ? ' with resend' : ''
  throw new TypeError(
    `Illegal identity attempt transition "${event.type}${resend}" from phase "${attempt.phase}".`,
  )
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

  const headers = Object.freeze([
    ...new Set(
      provers.flatMap((prover) => {
        if (prover.headers !== undefined && !Array.isArray(prover.headers))
          throw new TypeError('Identity prover headers must be an array of header names.')
        return (prover.headers ?? []).map((name) => name.toLowerCase())
      }),
    ),
  ])

  const inScope = (url: string) => {
    const origin = new URL(url).origin
    return provers.filter((prover) => prover.scope === '*' || prover.scope.includes(origin))
  }

  async function sendOnce(parameters: {
    fetch: typeof globalThis.fetch
    request: Request
    context: SendContext
    keepReadable: boolean
    headers: ResendHeaders
  }): Promise<{ request: Request; response: Response }> {
    const { context, fetch, headers, keepReadable, request } = parameters
    // Keep the original readable only when it may be resent; otherwise a clone would tee
    // (and buffer) a streamed body that is never read again.
    const source = keepReadable ? request.clone() : request
    const scoped = inScope(request.url)
    if (scoped.length === 0) return { request: source, response: await fetch(source) }
    const attempt: Types.ProveContext = Object.freeze({
      ...SigningContext.create(),
      ...(context.challenge && { challenge: context.challenge }),
    })
    // Resend headers are set before the provers run, so signing provers cover them.
    const merged = new Headers(source.headers)
    // Retry headers never replace a payment credential: the fixed credential headers, the one the
    // Challenge names, or any header that already holds a Payment credential.
    const protectedHeaders = new Set(credentialHeaders)
    if (context.challenge)
      protectedHeaders.add(Challenge.credentialHeader(context.challenge).toLowerCase())
    for (const [name, value] of source.headers)
      if (Credential.extractPaymentScheme(value) !== null) protectedHeaders.add(name.toLowerCase())
    for (const [name, value] of headers)
      if (!protectedHeaders.has(name.toLowerCase())) merged.set(name, value)
    let sent = new Request(source, {
      headers: merged,
      redirect: request.redirect === 'follow' ? 'error' : request.redirect,
    })
    for (const prover of scoped) sent = await prover.prove(sent, attempt)
    return { request: sent, response: await fetch(sent) }
  }

  return {
    headers,
    async send(fetch, request, context = {}) {
      let attempt = transition(initial, {
        type: 'send',
        payment: isPaid(request, context) ? 'paid' : 'unpaid',
      })
      const scoped = inScope(request.url)
      const retriers = scoped.filter((prover) => prover.retry)
      const offerers = scoped.filter((prover) => prover.offer)
      const keepReadable = attempt.phase === 'sent' && (retriers.length > 0 || offerers.length > 0)
      const carried = context.headers ?? []
      const result = await sendOnce({ context, fetch, headers: carried, keepReadable, request })
      const { response } = result
      const resend = await (() => {
        if (!keepReadable) return undefined
        // An unpaid 402 may offer a better price for more identity; other errors may ask for it.
        if (response.status === 402)
          return resendHeaders(offerers, response, result.request, 'offer')
        if (response.status >= 400)
          return resendHeaders(retriers, response, result.request, 'retry')
        return undefined
      })()
      attempt = transition(attempt, { type: 'response', resend })
      if (attempt.phase !== 'resent') return { ...result, headers: carried }
      release([response])
      const headers = mergeHeaders(carried, attempt.headers)
      const resent = await sendOnce({ context, fetch, headers, keepReadable: false, request })
      transition(attempt, { type: 'response', resend: undefined })
      return { ...resent, headers }
    },
    async challenge(response, { challenge }, url) {
      const context: Types.PrepareContext = Object.freeze({
        challenge,
        requirements: Requirements.parse(response.headers.get(Requirements.header)),
      })
      for (const prover of inScope(url)) {
        if (!prover.prepare) continue
        const copy = response.clone()
        try {
          await prover.prepare(copy, context)
        } finally {
          release([copy])
        }
      }
    },
  }
}

/**
 * Whether a send is a paid attempt: a Challenge in context, or a Payment or x402 credential the
 * caller attached. Its credential may already have settled, so replaying it could pay again.
 */
function isPaid(request: Request, context: SendContext): boolean {
  return (
    context.challenge !== undefined ||
    x402CredentialHeaders.some((name) => request.headers.has(name)) ||
    [...request.headers.values()].some((value) => Credential.extractPaymentScheme(value) !== null)
  )
}

/**
 * Asks each prover whether to resend a response (`retry` for a rejection, `offer` for an unpaid
 * 402), each on its own copy so the response stays readable, with the request that got it.
 * Returns the headers to resend with (same-named headers from several provers are combined,
 * comma-separated, in prover order), or `undefined` when no prover asks to resend.
 */
async function resendHeaders(
  provers: readonly Types.Prover[],
  response: Response,
  request: Request,
  hook: 'retry' | 'offer',
): Promise<ResendHeaders | undefined> {
  const context: Types.RetryContext = Object.freeze({ request })
  const copies: Response[] = []
  let resend = false
  const headers = new Headers()
  try {
    for (const prover of provers) {
      const copy = response.clone()
      copies.push(copy)
      const decision =
        hook === 'retry'
          ? await prover.retry!(copy, context)
          : // An offer is optional: a prover that fails declines it, and the 402 is paid as is.
            await Promise.resolve()
              .then(() => prover.offer!(copy, context))
              .catch(() => undefined)
      if (decision === true) resend = true
      else if (typeof decision === 'object' && decision !== null) {
        resend = true
        // Same-named headers from several provers are combined, so each one's values resend.
        // Payment credential headers are never set from a retry.
        for (const [name, value] of new Headers(decision))
          if (!credentialHeaders.has(name)) headers.append(name, value)
      }
    }
  } finally {
    release(copies)
  }
  if (!resend) return undefined
  return Object.freeze([...headers].map(([name, value]) => Object.freeze([name, value] as const)))
}

/** Releases unread response copies without waiting, so they neither buffer the body nor block a resend. */
function release(responses: readonly Response[]) {
  for (const unread of responses) if (!unread.bodyUsed) void unread.body?.cancel().catch(() => {})
}

/**
 * Wraps a fetch implementation so every request is proved.
 *
 * Prefer `Mppx.create({ identity })`, which also passes the payment Challenge to provers.
 */
export function wrapFetch(
  fetch: typeof globalThis.fetch,
  client: Client,
  context: SendContext = {},
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    // A request carrying a Payment Credential is a paid attempt for that Credential's Challenge,
    // which provers bind their proofs to; otherwise the wrapper's context applies.
    const challenge = credentialChallenge(request.headers) ?? context.challenge
    const { response } = await client.send(
      (input, options) =>
        fetch(input, {
          ...options,
          ...((init as RequestInit & { [skipPayment]?: boolean })?.[skipPayment]
            ? { [skipPayment]: true }
            : {}),
        }),
      request,
      { ...context, challenge },
    )
    if (response.status === 402 && challenge)
      // Provers prepare for a refreshed 402 of the same method and intent. A 402 without a
      // parseable Payment challenge is returned as is: the caller decides.
      for (const next of challengesOf(response))
        if (next.method === challenge.method && next.intent === challenge.intent)
          await client.challenge(response, { challenge: next }, request.url)
    return response
  }
}

/** Returns the Challenge of a Payment Credential in `headers`, if any. */
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

/** Returns the Payment challenges of a 402, or none when it carries none that parse. */
function challengesOf(response: Response): readonly Challenge.Challenge[] {
  try {
    return Challenge.fromResponseList(response)
  } catch {
    return []
  }
}

/** Merges two lists of retry headers; `next` replaces same-named headers of `previous`. */
function mergeHeaders(previous: ResendHeaders, next: ResendHeaders): ResendHeaders {
  const merged = new Headers()
  for (const [name, value] of previous) merged.set(name, value)
  for (const [name, value] of next) merged.set(name, value)
  return Object.freeze([...merged].map((entry) => Object.freeze(entry)))
}
