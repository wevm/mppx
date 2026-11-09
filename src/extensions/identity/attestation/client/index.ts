import { isInnerList, parseList, Token as SfToken } from 'structured-headers'

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
 * the prover obtains at most one attestation per listed type and resends the request with it.
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
      const entry = toEntry(token)
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
      const existing = request.headers.get(Constants.header)
      const present = new Set(Token.parseHeader(existing))
      const time = now()
      const tokens = [...slots.values()]
        .map(Cache.entryOf)
        .filter(
          (entry): entry is Cache.Entry =>
            entry?.claims.aud === origin &&
            Cache.usable(entry, time, attempt) &&
            !present.has(entry.token),
        )
        .map(({ token }) => token)
      if (tokens.length === 0) return request
      const headers = new Headers(request.headers)
      headers.set(Constants.header, [existing, ...tokens].filter(Boolean).join(', '))
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
      const tokens: string[] = []
      let failure: { error: unknown } | undefined
      const decide = (key: string) =>
        Cache.decide({
          now: now(),
          sent: sent.get(key) ?? [],
          slot: slots.get(key),
        })
      for (const alternatives of byType(requirements(response.headers), audience)) {
        const decision = Cache.plan(alternatives.map(({ key }) => decide(key)))
        try {
          const entry = await (async () => {
            if (decision.action === 'reuse') return decision.entry
            if (decision.action === 'skip' || !config.acquire) return undefined
            // A route may accept any one of the listed issuers, so one that fails does not stop
            // the next, whether this retry started it or joined another's; a decline does, so
            // the user is asked once.
            let error: { error: unknown } | undefined
            for (const { key, requirement } of alternatives) {
              // Decided again, since an earlier alternative's failure took time.
              const next = decide(key)
              if (next.action === 'skip') continue
              if (next.action === 'reuse') return next.entry
              try {
                return await (next.action === 'join'
                  ? next.pending
                  : acquire(key, requirement, audience, next.rejected))
              } catch (caught) {
                error ??= { error: caught }
              }
            }
            if (error) throw error.error
            return undefined
          })()
          if (entry) tokens.push(entry.token)
        } catch (error) {
          failure ??= { error }
        }
      }
      // A failure surfaces only when nothing was obtained, so another type's attestation still resends.
      if (tokens.length === 0) {
        if (failure) throw failure.error
        return undefined
      }
      return { [Constants.header]: tokens.join(', ') }
    },
  }

  /** Groups the trusted requirements by type, each once, in listed order. */
  function byType(list: readonly Types.Requirement[], audience: string) {
    const groups = new Map<string, { key: string; requirement: Trusted }[]>()
    for (const { issuer, type } of list) {
      if (!issuer || !issuers?.includes(issuer)) continue
      if (config.types && !config.types.includes(type)) continue
      const key = Cache.keyOf({ aud: audience, iss: issuer, type })
      const group = groups.get(type) ?? []
      if (!group.some((alternative) => alternative.key === key))
        group.push({ key, requirement: { issuer, type } })
      groups.set(type, group)
    }
    return [...groups.values()]
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

/** Parses the attestation requirements of a rejected response, skipping malformed members. */
export function requirements(headers: Headers): readonly Types.Requirement[] {
  const value = headers.get(Constants.requiredHeader)
  if (!value) return []
  let list: ReturnType<typeof parseList>
  try {
    list = parseList(value)
  } catch {
    return []
  }
  const result: Types.Requirement[] = []
  for (const member of list) {
    if (isInnerList(member) || !(member[0] instanceof SfToken)) continue
    const type = member[0].toString()
    const issuer = member[1].get('issuer')
    if (issuer === undefined) result.push(Object.freeze({ type }))
    else if (typeof issuer === 'string' && Token.isIssuer(issuer))
      result.push(Object.freeze({ type, issuer }))
  }
  return Object.freeze(result)
}

/** A requirement from a trusted issuer. */
type Trusted = { readonly type: string; readonly issuer: string }

/** The current Unix time, in seconds. */
function now() {
  return Math.floor(Date.now() / 1_000)
}

/** Decodes a token into a frozen cache entry, or throws a `TypeError` if it is malformed. */
function toEntry(token: string): Cache.Entry {
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
  return Object.freeze({ token, claims: Object.freeze({ ...claims }) as Types.Claims })
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
