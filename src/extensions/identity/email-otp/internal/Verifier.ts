import { serializeList, Token } from 'structured-headers'
import type { Item } from 'structured-headers'

import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from './Attestation.js'
import { Constants } from './Constants.js'
import * as Jwks from './Jwks.js'
import type * as Types from './Types.js'

/**
 * Creates a request-stage verifier for one type of identity attestation from one issuer.
 *
 * A request without a matching `Identity-Attestation` is rejected with 401 and an
 * `Identity-Attestation-Required` header naming the type and issuer, which a
 * client prover answers by obtaining an attestation and retrying. Attestations of
 * other types or issuers in the same header are left to their own verifiers.
 *
 * An attestation is a bearer proof bound to this server's origin until it
 * expires; it says what the issuer checked, not what the subject may do.
 *
 * @example
 * ```ts
 * const email = Attestation.Server.verifier({
 *   audience: 'https://api.example',
 *   issuer: 'https://issuer.example',
 *   type: 'email',
 * })
 * mppx.charge({ amount: '1', identity: [email] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.Verified> {
  const issuer = config.issuer.replace(/\/+$/, '')
  if (!URL.canParse(issuer)) throw new TypeError('Attestation issuer must be a URL.')
  const keyResolver = config.keyResolver ?? Jwks.resolver({ fetch: config.fetch })
  const required = {
    [Constants.requiredHeader]: serializeList([
      [new Token(config.type), new Map([['issuer', issuer]])] as Item,
    ]),
  }
  return {
    stage: 'request',
    async verify(request) {
      const tokens = Attestation.parseHeader(request.headers.get(Constants.header)).filter(
        (token) => {
          const claims = Attestation.decode(token)?.claims
          return claims?.iss === issuer && claims.type === config.type
        },
      )
      if (tokens.length === 0)
        return {
          status: 'missing',
          code: 401,
          headers: required,
          reason: `An identity attestation of type "${config.type}" is required.`,
        }
      const audience =
        typeof config.audience === 'function' ? config.audience(request) : config.audience
      let reason = 'The identity attestation is invalid.'
      for (const token of tokens) {
        const result = await Attestation.verify(token, {
          audience,
          clockTolerance: config.clockTolerance,
          issuer,
          keyResolver,
          maxAge: config.maxAge,
          type: config.type,
        })
        if (result.status === 'invalid') {
          reason = result.reason
          continue
        }
        const rejected = await config.validate?.(result.claims, request)
        if (rejected) return { status: 'invalid', code: 403, reason: rejected }
        return { status: 'valid', value: { claims: result.claims } }
      }
      // The client may obtain a fresh attestation and retry.
      return { status: 'invalid', code: 401, headers: required, reason }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Accepted attestation type, such as `email`. */
    type: string
    /** Trusted issuer URL. */
    issuer: string
    /**
     * This server's public origin, such as `https://api.example`, which attestations must be bound to.
     *
     * A function may derive it from the request, but only where the platform
     * guarantees the request's host (such as a Cloudflare Worker route): many
     * Node servers build the URL from the client's `Host` header, which would let
     * another server's attestation through.
     */
    audience: string | ((request: Request) => string)
    /** Resolves issuer keys. Defaults to the issuer's JSON Web Key Set. */
    keyResolver?: Types.KeyResolver | undefined
    /** Fetch used for the default JSON Web Key Set resolver. */
    fetch?: typeof globalThis.fetch | undefined
    /** Oldest accepted `iat`, in seconds before now. Defaults to the attestation's own `exp`. */
    maxAge?: number | undefined
    /** Clock tolerance in seconds. @default 60 */
    clockTolerance?: number | undefined
    /**
     * Applies the route's policy to verified claims. Return a reason to reject
     * the request with 403, or `undefined` to accept it.
     */
    validate?:
      | ((claims: Types.Claims, request: Request) => MaybePromise<string | undefined>)
      | undefined
  }
}
