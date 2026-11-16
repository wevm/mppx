import type * as Credential from '../Credential.js'
import { PaymentExpiredError } from '../Errors.js'
import * as Expires from '../Expires.js'

/**
 * Lets a server method keep accepting some credentials for a bounded time after their
 * challenge expires: for a payment that the method can prove completed before then, but
 * whose credential only arrived later. The method enforces that proof itself.
 */
export type GraceFn = (credential: Credential.Credential) => number | undefined

// A symbol-keyed property survives the spreads that copy and configure methods.
const graceKey = Symbol.for('mppx.credentialExpiryGrace')

/** Registers `grace` on a server method without changing its public shape. */
export function register<const method extends object>(method: method, grace: GraceFn): method {
  return Object.assign(method, { [graceKey]: grace })
}

/** Milliseconds after its challenge's expiry that `method` still accepts `credential`, if any. */
export function getGraceMs(method: object | undefined, credential: Credential.Credential) {
  const grace = (method as { [graceKey]?: GraceFn } | undefined)?.[graceKey]
  return grace?.(credential)
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
