import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * The client's attestation cache as data: slots keyed by audience, issuer and type, with pure
 * functions for what a prover sends and how a retry answers a rejection.
 */

/**
 * A cached attestation: the token and its decoded claims, frozen. `received` is the client's
 * time when it acquired the attestation; one given beforehand has none.
 */
export type Entry = {
  readonly token: string
  readonly claims: Types.Claims
  readonly received?: number | undefined
}

/**
 * One cache slot, as a state machine. A missing slot (`undefined`) holds nothing.
 *
 * - `held`: an attestation is cached.
 * - `acquiring`: an acquisition is pending, which concurrent retries join. `previous`, the
 *   attestation it replaces, is still sent until it settles, unless the server rejected it.
 */
export type Slot =
  | { readonly phase: 'held'; readonly entry: Entry }
  | {
      readonly phase: 'acquiring'
      readonly pending: Promise<Entry | undefined>
      readonly previous?: Entry | undefined
    }

/** An input to {@link transition}. */
export type Event =
  /** An acquisition starts; `rejected` is the token the server rejected, if any. */
  | {
      readonly type: 'acquire'
      readonly pending: Promise<Entry | undefined>
      readonly rejected?: string | undefined
    }
  /** The acquisition settled, with the attestation it obtained or `undefined`. */
  | { readonly type: 'settle'; readonly entry: Entry | undefined }

/** Whether an attempt pays: a paid attempt is never resent. */
export type Attempt = 'paid' | 'unpaid'

/** How a retry answers one requirement, or one type's alternatives. */
export type Decision =
  /** Resend with an attestation the cache already holds. */
  | { readonly action: 'reuse'; readonly entry: Entry }
  /** Wait for a pending acquisition of the same attestation. */
  | { readonly action: 'join'; readonly pending: Promise<Entry | undefined> }
  /** Obtain a new attestation, replacing `rejected` if the request sent it. */
  | { readonly action: 'acquire'; readonly rejected?: string | undefined }
  /** Do nothing: a new attestation would not change the outcome. */
  | { readonly action: 'skip' }

/** Order in which a retry tries a group's alternatives: no new attestation first. */
const rank = { reuse: 0, join: 1, acquire: 2, skip: 3 } as const satisfies Record<
  Decision['action'],
  number
>

/**
 * Orders the alternatives of one requirement group for a retry, as data: one the cache holds
 * first, then one being acquired, then those to acquire, each in listed order. Skipped ones are
 * dropped. Pure.
 */
export function order<alternative extends { readonly decision: Decision }>(
  alternatives: readonly alternative[],
): readonly alternative[] {
  return alternatives
    .filter(({ decision }) => decision.action !== 'skip')
    .sort((a, b) => rank[a.decision.action] - rank[b.decision.action])
}

/** Returns the cache key of an attestation. */
export function keyOf(claims: Pick<Types.Claims, 'aud' | 'iss' | 'type'>): string {
  return JSON.stringify([claims.aud, claims.iss, claims.type])
}

/**
 * Returns the next slot. Pure; throws a `TypeError` for an event the slot does not accept.
 *
 * | Slot              | Event                 | Next                                        |
 * | ----------------- | --------------------- | ------------------------------------------- |
 * | none, `held`      | `acquire`             | `acquiring`, keeping the entry unless rejected |
 * | `acquiring`       | `settle` with entry   | `held` with the new entry                    |
 * | `acquiring`       | `settle` without      | `held` with `previous`, or none               |
 */
export function transition(slot: Slot | undefined, event: Event): Slot | undefined {
  if (event.type === 'acquire' && slot?.phase !== 'acquiring') {
    const previous = slot?.entry.token === event.rejected ? undefined : slot?.entry
    return Object.freeze({ phase: 'acquiring', pending: event.pending, previous })
  }
  if (event.type === 'settle' && slot?.phase === 'acquiring') {
    const entry = event.entry ?? slot.previous
    return entry ? Object.freeze({ phase: 'held', entry }) : undefined
  }
  throw new TypeError(
    `Illegal attestation cache transition "${event.type}" from "${slot?.phase ?? 'none'}".`,
  )
}

/** Returns the attestation a slot sends: the held one, or the one being replaced. */
export function entryOf(slot: Slot): Entry | undefined {
  return slot.phase === 'held' ? slot.entry : slot.previous
}

/**
 * Seconds before expiry at which an unpaid attempt stops sending an attestation: the refresh
 * margin, capped at half its lifetime so a short-lived attestation is still sent. The lifetime
 * of an acquired attestation runs from when the client received it, not the issuer's `iat`,
 * so an issuer whose clock trails the client's cannot make every fresh one look expiring and
 * force a new acquisition on each request.
 */
export function margin(entry: Pick<Entry, 'claims' | 'received'>): number {
  const { exp, iat } = entry.claims
  return Math.min(Constants.refreshMargin, Math.floor((exp - (entry.received ?? iat)) / 2))
}

/**
 * Whether an attestation may be sent at `now`: on a paid attempt until it expires beyond the
 * clock tolerance, since dropping it could reject a payment already pushed; on an unpaid one only
 * outside the refresh {@link margin}, so it is replaced before paying.
 */
export function usable(entry: Entry, now: number, attempt: Attempt): boolean {
  const { exp } = entry.claims
  if (exp <= now - Constants.clockTolerance) return false
  return attempt === 'paid' || exp - now > margin(entry)
}

/**
 * Decides how a retry answers one requirement, from its slot and the tokens for it that the
 * rejected request sent. Pure.
 *
 * - A pending acquisition is joined.
 * - A listed requirement is answered whatever the response's status: a verifier lists its
 *   requirement only when a fresh attestation could pass, even when another verifier made the
 *   combined status 403.
 * - A cached attestation the request sent is replaced: the server rejected it.
 * - A different, unexpired one is reused: it is newer than what the request sent, or the request
 *   sent none and it is outside the refresh margin.
 * - Otherwise a new one is acquired.
 */
export function decide(parameters: {
  readonly slot: Slot | undefined
  readonly sent: readonly string[]
  readonly now: number
}): Decision {
  const { now, sent, slot } = parameters
  if (slot?.phase === 'acquiring') return { action: 'join', pending: slot.pending }
  const entry = slot?.entry
  if (!entry || !usable(entry, now, 'paid')) return { action: 'acquire', rejected: entry?.token }
  if (sent.includes(entry.token)) return { action: 'acquire', rejected: entry.token }
  if (sent.length > 0 || usable(entry, now, 'unpaid')) return { action: 'reuse', entry }
  return { action: 'acquire' }
}
