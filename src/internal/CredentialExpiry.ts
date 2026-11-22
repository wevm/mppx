import type * as Credential from '../Credential.js'
import { PaymentExpiredError } from '../Errors.js'
import * as Expires from '../Expires.js'
import * as ChallengeMeta from './challengeMeta.js'

/**
 * Lets a server method keep accepting some credentials for a bounded time after their
 * challenge expires: for a payment that the method can prove completed before then, but
 * whose credential only arrived later. The method enforces that proof itself.
 */
export type GraceFn = (credential: Credential.Credential) => number | undefined

/** What a server method registers: its grace, and whether the challenges it issues allow one. */
type Registration = {
  /** Grace for a credential whose challenge carries the expiry grace marker. */
  grace: GraceFn
  /** Whether challenges this method issues carry the expiry grace marker. */
  issue: boolean
}

// A symbol-keyed property survives the spreads that copy and configure methods.
const graceKey = Symbol.for('mppx.credentialExpiryGrace')

/**
 * Registers `grace` on a server method without changing its public shape. Only challenges
 * issued while `issue` is true carry the marker that grace requires, so a challenge issued
 * without it (by an earlier release, or with no grace configured) never gets any.
 */
export function register<const method extends object>(
  method: method,
  grace: GraceFn,
  options: { issue: boolean },
): method {
  const registration: Registration = { grace, issue: options.issue }
  return Object.assign(method, { [graceKey]: registration })
}

function getRegistration(method: object | undefined) {
  return (method as { [graceKey]?: Registration } | undefined)?.[graceKey]
}

/** Challenge metadata for a challenge `method` issues: with the expiry grace marker or without it. */
export function issuanceMeta(
  method: object | undefined,
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return ChallengeMeta.withExpiryGrace(meta, getRegistration(method)?.issue === true)
}

/**
 * Milliseconds after its challenge's expiry that `method` still accepts `credential`, if any.
 * None for a challenge issued without the expiry grace marker.
 */
export function getGraceMs(method: object | undefined, credential: Credential.Credential) {
  if (!ChallengeMeta.hasExpiryGrace(credential.challenge)) return undefined
  return getRegistration(method)?.grace(credential)
}

/**
 * Asserts that the credential's challenge has a well-formed `expires` that has not passed, or
 * that passed less than `graceMs` ago.
 */
export function assert(credential: Credential.Credential, graceMs: number | undefined): void {
  const { expires, id } = credential.challenge
  try {
    Expires.assert(expires, id)
  } catch (error) {
    if (!(error instanceof PaymentExpiredError)) throw error
    if (!graceMs || Date.parse(expires!) + graceMs <= Date.now()) throw error
  }
}

/** Asserts the credential has not expired, allowing the grace `method` registered for it. */
export function assertFor(method: object | undefined, credential: Credential.Credential): void {
  assert(credential, getGraceMs(method, credential))
}
