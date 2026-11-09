import { serializeList, Token as SfToken } from 'structured-headers'
import type { Item } from 'structured-headers'

import * as Status from '../../../../identity/Status.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import * as Jwks from '../Jwks.js'
import * as Token from '../Token.js'
import type * as Types from '../Types.js'

/**
 * Creates a request-stage verifier for one type of identity attestation from one issuer.
 *
 * Outcomes:
 * - `missing` (401): no attestation of this type and issuer, with an
 *   `Identity-Attestation-Required` header naming them, which a client prover answers by
 *   obtaining one and retrying.
 * - `invalid` (401): none verified, with the same header so the client can obtain a fresh one.
 * - `forbidden` (403): one verified, but `validate` rejected it.
 * - `unavailable` (503): the issuer's keys could not be fetched, so the client keeps its
 *   attestation instead of asking for a new one.
 *
 * Attestations of other types or issuers in the same header are left to their own verifiers.
 * An attestation is a bearer proof bound to this server's origin until it expires; it says what
 * the issuer checked, not what the subject may do.
 *
 * @example
 * ```ts
 * const phone = Attestation.Server.verifier({
 *   audience: 'https://api.example',
 *   issuer: 'https://issuer.example',
 *   type: 'phone',
 * })
 * mppx.charge({ amount: '1', identity: [phone] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.Verified> {
  const issuer = config.issuer.replace(/\/+$/, '')
  if (!Token.isIssuer(issuer))
    throw new TypeError('Attestation issuer must be an https URL (http only on localhost).')
  Token.assertTimes({ clockTolerance: config.clockTolerance, maxAge: config.maxAge })
  const keyResolver = config.keyResolver ?? Jwks.resolver({ fetch: config.fetch })
  const tolerance = config.clockTolerance ?? Constants.clockTolerance
  const required = Object.freeze({
    [Constants.requiredHeader]: serializeList([
      [new SfToken(config.type), new Map([['issuer', issuer]])] as Item,
    ]),
  })
  return {
    async verify(request) {
      const audience = origin(
        typeof config.audience === 'function' ? config.audience(request) : config.audience,
      )
      // At most `maxCandidates` distinct tokens are verified, latest expiry first,
      // so repeated or forged tokens cost a bounded number of signature checks.
      // A stray forged token does not hide a valid one, but whoever controls the
      // header can always withhold a valid token, so the bound is not a guarantee
      // against that sender. Without a usable one, the first is verified so its
      // rejection says why.
      const now = Math.floor(Date.now() / 1_000)
      const candidates = Token.parseHeader(request.headers.get(Constants.header))
        .map((token) => ({ token, claims: Token.decode(token)?.claims }))
        .filter(({ claims }) => claims?.iss === issuer && claims.type === config.type)
      const usable = candidates
        .filter(({ claims }) => claims?.aud === audience && (claims.exp ?? 0) > now - tolerance)
        .sort((a, b) => (b.claims?.exp ?? 0) - (a.claims?.exp ?? 0))
      const tokens = [
        ...new Set((usable.length > 0 ? usable : candidates).map(({ token }) => token)),
      ].slice(0, usable.length > 0 ? maxCandidates : 1)
      if (tokens.length === 0)
        return {
          status: 'missing',
          headers: required,
          reason: `An identity attestation of type "${config.type}" is required.`,
        }
      // Every token's outcome, so the most decisive one answers when none is valid.
      const rejections: Rejection[] = []
      for (const token of tokens) {
        const result = await Token.verify(token, {
          audience,
          clockTolerance: config.clockTolerance,
          issuer,
          keyResolver,
          maxAge: config.maxAge,
          type: config.type,
        })
        if (result.status !== 'valid') {
          rejections.push(result)
          continue
        }
        // A later attestation, such as another address, may still be allowed.
        // Only `undefined` accepts, so an empty or otherwise falsy reason still rejects.
        const reason = config.validate ? await config.validate(result.claims, request) : undefined
        if (reason !== undefined) {
          rejections.push({
            status: 'forbidden',
            reason: typeof reason === 'string' && reason ? reason : defaultForbiddenReason,
          })
          continue
        }
        return { status: 'valid', value: Object.freeze({ claims: result.claims }) }
      }
      const rejection = decisive(rejections)
      // Only an invalid attestation is worth replacing: the client may obtain a fresh one.
      return rejection.status === 'invalid' ? { ...rejection, headers: required } : rejection
    },
  }
}

export declare namespace verifier {
  /**
   * Derives this server's origin from the request.
   *
   * @deprecated Pass the origin as a string. A function is only safe where the platform
   * guarantees the request's host (such as a Cloudflare Worker route): many Node servers build
   * the URL from the client's `Host` header, which would let another server's attestation through.
   */
  type AudienceFunction = (request: Request) => string

  type Config = {
    /** Accepted attestation type, such as `email` or `phone`. */
    readonly type: string
    /** Trusted issuer URL. */
    readonly issuer: string
    /**
     * This server's public origin, such as `https://api.example`, which attestations must be
     * bound to. The function form is deprecated: see {@link AudienceFunction}.
     */
    readonly audience: string | AudienceFunction
    /** Resolves issuer keys. Defaults to the issuer's JSON Web Key Set. */
    readonly keyResolver?: Types.KeyResolver | undefined
    /** Fetch used for the default JSON Web Key Set resolver. */
    readonly fetch?: typeof globalThis.fetch | undefined
    /** Oldest accepted `iat`, in seconds before now. Defaults to the attestation's own `exp`. */
    readonly maxAge?: number | undefined
    /** Clock tolerance in seconds. @default 60 */
    readonly clockTolerance?: number | undefined
    /**
     * Applies the route's policy to verified claims. Return `undefined` to accept it; any other
     * value, an empty string included, rejects the request as `forbidden` (403), with the value as
     * the reason when it is a non-empty string.
     */
    readonly validate?:
      | ((claims: Types.Claims, request: Request) => MaybePromise<string | undefined>)
      | undefined
  }
}

/** The reason sent when `validate` rejects without a usable one. */
const defaultForbiddenReason = 'This identity attestation is not allowed.'

/** Why one token did not verify. */
type Rejection = {
  readonly status: 'invalid' | 'forbidden' | 'unavailable'
  readonly reason: string
}

/** Returns the first rejection of the status with the highest precedence. `rejections` is never empty. */
function decisive(rejections: readonly Rejection[]): Rejection {
  for (const status of Status.precedence) {
    const rejection = rejections.find((candidate) => candidate.status === status)
    if (rejection) return rejection
  }
  return rejections[0]!
}

/** Most distinct attestations of one type and issuer verified per request. */
const maxCandidates = 3

/** An audience as the origin attestations carry, so `https://api.example/` matches. */
function origin(audience: string): string {
  return URL.canParse(audience) ? new URL(audience).origin : audience
}
