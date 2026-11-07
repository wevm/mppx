import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from '../../attestation/server/index.js'
import type * as AttestationTypes from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a request-stage verifier that requires a verified email address.
 *
 * A request without one gets 401 with `Identity-Attestation-Required: email;issuer="…"`.
 * The client obtains an attestation from the issuer with a one-time code sent to
 * the address and sends it in `Identity-Attestation`. `allow` applies the
 * route's policy, such as a domain allowlist.
 *
 * @example
 * ```ts
 * const email = EmailOtp.Server.verifier({
 *   audience: 'https://api.example',
 *   issuer: 'https://issuer.example',
 *   allow: (email) => email.endsWith('@example.com'),
 * })
 * const result = await mppx.charge({ amount: '1', identity: [email] })(request)
 * if (result.status === 200) result.identity?.get(email)?.email
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedEmail> {
  const inner = Attestation.verifier({
    audience: config.audience,
    clockTolerance: config.clockTolerance,
    fetch: config.fetch,
    issuer: config.issuer,
    keyResolver: config.keyResolver,
    maxAge: config.maxAge,
    type: Constants.type,
    async validate(claims, request) {
      if (!config.allow || (await config.allow(claims.sub.toLowerCase(), request))) return undefined
      return 'This email address is not allowed.'
    },
  })
  return {
    stage: 'request',
    async verify(request, context) {
      const result = await inner.verify(request, context)
      if (result.status !== 'valid') return result
      const { claims } = result.value
      return {
        status: 'valid',
        value: {
          email: claims.sub.toLowerCase(),
          expiresAt: new Date(claims.exp * 1_000),
          id: claims.jti,
          issuer: claims.iss,
        },
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Trusted issuer URL. */
    issuer: string
    /** Accepts or rejects (403) a verified, lowercased email address. Defaults to any. */
    allow?: ((email: string, request: Request) => MaybePromise<boolean>) | undefined
    /**
     * This server's public origin, such as `https://api.example`, which attestations must be bound to.
     *
     * A function may derive it from the request only where the platform
     * guarantees the request's host (such as a Cloudflare Worker route).
     */
    audience: string | ((request: Request) => string)
    /** Resolves issuer keys. Defaults to the issuer's JSON Web Key Set. */
    keyResolver?: AttestationTypes.KeyResolver | undefined
    /** Fetch used for the default JSON Web Key Set resolver. */
    fetch?: typeof globalThis.fetch | undefined
    /** Oldest accepted attestation, in seconds since it was issued. Defaults to its own expiry. */
    maxAge?: number | undefined
    /** Clock tolerance in seconds. @default 60 */
    clockTolerance?: number | undefined
  }
}
