import { isInnerList, parseList, Token as SfToken } from 'structured-headers'
import type { Item } from 'structured-headers'

import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import * as Cache from '../internal/Cache.js'
import * as Token from '../Token.js'
import type * as Types from '../Types.js'

/**
 * Creates a prover that presents identity attestations, and obtains them when a server asks.
 *
 * Each in-scope request carries, in `Identity-Attestation`, the cached attestations whose
 * audience is the request's origin: on a paid attempt every one not expired beyond the clock
 * tolerance, on an unpaid one only those outside the refresh margin, so one close to expiry is
 * replaced before paying. When a server answers 401 or 403 with `Identity-Attestation-Required`,
 * the prover meets each listed group (see {@link requirements}) with one attestation from a
 * trusted issuer, and resends the request with them, keeping the attestations it already carried.
 * Within a group of alternatives it prefers one it holds, and otherwise acquires them in listed
 * order until one succeeds, so a route accepting any of several issuers costs one acquisition.
 *
 * Trust is set by two options together:
 * - `scope`: the origins that may receive attestations and ask for new ones. The audience is
 *   always the request's own origin, never one a server names, so a server cannot obtain an
 *   attestation it could replay elsewhere.
 * - `issuers`: the issuers `acquire` may be asked for. A server only names an issuer; an
 *   untrusted one could relay a code and obtain an attestation for another origin.
 *
 * @example
 * ```ts
 * Attestation.Client.prover({
 *   scope: ['https://api.example'],
 *   issuers: ['https://issuer.example'],
 *   types: ['phone'],
 *   acquire: ({ audience, issuer }) => obtainPhoneAttestation({ audience, issuer }),
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  if (config.acquire && !config.issuers)
    throw new TypeError('An attestation prover that acquires attestations must list its issuers.')
  // Compared as the verifier names them, without a trailing slash.
  const issuers = config.issuers?.map((issuer) => issuer.replace(/\/+$/, ''))
  const slots = new Map<string, Cache.Slot>()
  // Tokens a retry replaced because the server rejected them. Several provers' resend headers
  // are combined, so another prover may carry one back; `prove` drops them.
  const replaced = new Set<string>()
  const update = (key: string, event: Cache.Event) => {
    const next = Cache.transition(slots.get(key), event)
    if (next) slots.set(key, next)
    else slots.delete(key)
  }
  for (const token of config.attestations ?? []) {
    const entry = toEntry(token)
    slots.set(Cache.keyOf(entry.claims), Object.freeze({ phase: 'held', entry }))
  }

  /** Starts acquiring one requirement, so concurrent retries join it. */
  function acquire(
    key: string,
    requirement: Trusted,
    audience: string,
    rejected: string | undefined,
  ) {
    const task = (async () => {
      const token = await config.acquire!({ audience, ...requirement })
      if (!token) return undefined
      const entry = toEntry(token, now())
      // Only an attestation for this requirement is kept, so an issuer cannot plant one.
      return Cache.keyOf(entry.claims) === key ? entry : undefined
    })()
    const pending = task.then(
      (entry) => {
        update(key, { type: 'settle', entry })
        return entry
      },
      (error: unknown) => {
        update(key, { type: 'settle', entry: undefined })
        throw error
      },
    )
    update(key, { type: 'acquire', pending, rejected })
    return pending
  }

  return {
    scope: config.scope,
    prove(request, context) {
      const origin = new URL(request.url).origin
      // A bearer attestation never goes over plaintext HTTP, except to localhost.
      if (!Token.isIssuer(origin)) return request
      const attempt = context.challenge !== undefined ? 'paid' : 'unpaid'
      const time = now()
      // An attestation already on the request (such as one a retry carried on to the paid
      // attempt) is dropped once it has expired beyond the clock tolerance: the server would
      // reject it, so a fresher cached one goes in its place.
      const carried = Token.parseHeader(request.headers.get(Constants.header))
      for (const token of replaced) if (expired(token, origin, time)) replaced.delete(token)
      const kept = [...new Set(carried)].filter(
        (token) => !replaced.has(token) && !expired(token, origin, time),
      )
      const present = new Set(kept)
      const tokens = [...slots.values()]
        .map(Cache.entryOf)
        .filter(
          (entry): entry is Cache.Entry =>
            entry?.claims.aud === origin &&
            Cache.usable(entry, time, attempt) &&
            !present.has(entry.token),
        )
        .map(({ token }) => token)
      if (tokens.length === 0 && kept.length === carried.length) return request
      const headers = new Headers(request.headers)
      const value = [...kept, ...tokens].join(', ')
      if (value) headers.set(Constants.header, value)
      else headers.delete(Constants.header)
      return new Request(request, { headers })
    },
    async retry(response, context) {
      if (response.status !== 401 && response.status !== 403) return undefined
      // The resend goes to the request's URL, so attestations are bound to its origin, and a
      // response from any other origin (a followed redirect) is never answered.
      const target = context?.request.url ?? response.url
      if (!URL.canParse(target)) return undefined
      const audience = new URL(target).origin
      if (URL.canParse(response.url) && new URL(response.url).origin !== audience) return undefined
      if (!Token.isIssuer(audience)) return undefined
      const sent = sentTokens(context?.request)
      const obtained = new Map<string, string>()
      // Requirements tried in this retry, so one listed in several groups is acquired once.
      const tried = new Set<string>()
      let failure: { error: unknown } | undefined
      // Every group must be met; one alternative meets it.
      for (const group of requirements(response.headers)) {
        const alternatives = trusted(group, audience)
        if (alternatives.some(({ key }) => obtained.has(key))) continue
        const decided = alternatives
          .filter(({ key }) => !tried.has(key))
          .map((alternative) => ({
            ...alternative,
            decision: Cache.decide({
              now: now(),
              sent: sent.get(alternative.key) ?? [],
              slot: slots.get(alternative.key),
            }),
          }))
        for (const { decision, key, requirement } of Cache.order(decided)) {
          tried.add(key)
          try {
            const entry =
              decision.action === 'reuse'
                ? decision.entry
                : decision.action === 'join'
                  ? await decision.pending
                  : decision.action === 'acquire' && config.acquire
                    ? await acquire(key, requirement, audience, decision.rejected)
                    : undefined
            if (entry) {
              obtained.set(key, entry.token)
              break
            }
          } catch (error) {
            // One issuer failing does not stop the next alternative or the other groups.
            failure ??= { error }
          }
        }
      }
      // A failure surfaces only when nothing was obtained, so another attestation still resends.
      if (obtained.size === 0) {
        if (failure) throw failure.error
        return undefined
      }
      // The resend header replaces the request's, so the attestations the request already
      // carried stay, except those this retry replaced.
      for (const [key, tokens] of sent)
        if (obtained.has(key)) for (const token of tokens) replaced.add(token)
      const kept = [...sent].filter(([key]) => !obtained.has(key)).flatMap(([, tokens]) => tokens)
      return { [Constants.header]: [...kept, ...obtained.values()].join(', ') }
    },
  }

  /** The trusted requirements, each once, in listed order. */
  function trusted(list: readonly Types.Requirement[], audience: string) {
    const result = new Map<string, { key: string; requirement: Trusted }>()
    for (const { issuer, type } of list) {
      if (!issuer || !issuers?.includes(issuer)) continue
      if (config.types && !config.types.includes(type)) continue
      const key = Cache.keyOf({ aud: audience, iss: issuer, type })
      if (!result.has(key)) result.set(key, { key, requirement: { issuer, type } })
    }
    return [...result.values()]
  }
}

export declare namespace prover {
  type Config = {
    /** Origins that receive attestations and may ask for new ones, or `'*'` for any origin. */
    readonly scope: Identity.Prover['scope']
    /** Attestations obtained beforehand, such as from an issuer with curl. */
    readonly attestations?: readonly string[] | undefined
    /** Obtains an attestation a server requires, or returns `undefined` to decline. */
    readonly acquire?:
      | ((requirement: {
          /** Origin the attestation must be bound to. */
          readonly audience: string
          /** Issuer to obtain it from. */
          readonly issuer: string
          /** Attestation type. */
          readonly type: string
        }) => MaybePromise<string | undefined>)
      | undefined
    /** Issuers `acquire` may be asked for. Required with `acquire`. */
    readonly issuers?: readonly string[] | undefined
    /** Attestation types `acquire` may be asked for. Defaults to any. */
    readonly types?: readonly string[] | undefined
  }
}

/**
 * Parses the attestation requirements of a rejected response as groups, every one of which a
 * request must meet with any one of its requirements:
 *
 * - An item, such as `phone;issuer="https://a.example"`, is a group of one.
 * - An inner list, such as `(email;issuer="https://a.example" email;issuer="https://b.example")`,
 *   is a group of alternatives, as `Identity.anyOf` sends them.
 *
 * Malformed members are skipped, and a group left with none is dropped.
 */
export function requirements(headers: Headers): readonly (readonly Types.Requirement[])[] {
  const value = headers.get(Constants.requiredHeader)
  if (!value) return []
  let list: ReturnType<typeof parseList>
  try {
    list = parseList(value)
  } catch {
    return []
  }
  const groups = list
    .map((member) =>
      (isInnerList(member) ? member[0] : [member]).flatMap((item) => toRequirement(item) ?? []),
    )
    .filter((group) => group.length > 0)
    .map((group) => Object.freeze(group))
  return Object.freeze(groups)
}

/** Parses one requirement item, or returns `undefined` when it is malformed. */
function toRequirement([value, parameters]: Item): Types.Requirement | undefined {
  if (!(value instanceof SfToken)) return undefined
  const type = value.toString()
  const issuer = parameters.get('issuer')
  if (issuer === undefined) return Object.freeze({ type })
  if (typeof issuer === 'string' && Token.isIssuer(issuer)) return Object.freeze({ type, issuer })
  return undefined
}

/** A requirement from a trusted issuer. */
type Trusted = { readonly type: string; readonly issuer: string }

/** The current Unix time, in seconds. */
function now() {
  return Math.floor(Date.now() / 1_000)
}

/** Decodes a token into a frozen cache entry, or throws a `TypeError` if it is malformed. */
function toEntry(token: string, received?: number): Cache.Entry {
  const claims = Token.decode(token)?.claims
  if (
    !claims ||
    typeof claims.aud !== 'string' ||
    typeof claims.iss !== 'string' ||
    typeof claims.type !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  )
    throw new TypeError('Identity attestation is malformed.')
  return Object.freeze({
    token,
    claims: Object.freeze({ ...claims }) as Types.Claims,
    ...(received !== undefined && { received }),
  })
}

/** Whether a token for `origin` has expired beyond the clock tolerance at `now`. */
function expired(token: string, origin: string, now: number): boolean {
  const claims = Token.decode(token)?.claims
  return (
    claims?.aud === origin &&
    typeof claims.exp === 'number' &&
    claims.exp <= now - Constants.clockTolerance
  )
}

/** The attestation tokens a request sent, by cache key. */
function sentTokens(request: Request | undefined): ReadonlyMap<string, readonly string[]> {
  const sent = new Map<string, string[]>()
  for (const token of Token.parseHeader(request?.headers.get(Constants.header) ?? null)) {
    const claims = Token.decode(token)?.claims
    if (
      typeof claims?.aud !== 'string' ||
      typeof claims.iss !== 'string' ||
      typeof claims.type !== 'string'
    )
      continue
    const key = Cache.keyOf({ aud: claims.aud, iss: claims.iss, type: claims.type })
    sent.set(key, [...(sent.get(key) ?? []), token])
  }
  return sent
}
