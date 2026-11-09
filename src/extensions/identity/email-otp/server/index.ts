import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from '../../attestation/server/index.js'
import type * as AttestationTypes from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a request-stage verifier that requires a verified email address: an
 * `Attestation.Server.verifier` of type `email` whose `validate` is `allow`.
 *
 * A request without one gets 401 with `Identity-Attestation-Required: email;issuer="…"`.
 * The client obtains an attestation from the issuer with a one-time code sent to
 * the address and sends it in `Identity-Attestation`. An address `allow` rejects is
 * `forbidden` (403).
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
  const { allow } = config
  const inner = Attestation.verifier({
    audience: config.audience,
    clockTolerance: config.clockTolerance,
    fetch: config.fetch,
    issuer: config.issuer,
    keyResolver: config.keyResolver,
    maxAge: config.maxAge,
    type: Constants.type,
    ...(allow && {
      async validate(claims, request) {
        if (await allow(claims.sub.toLowerCase(), request)) return undefined
        return 'This email address is not allowed.'
      },
    }),
  })
  return {
    async verify(request) {
      const result = await inner.verify(request)
      if (result.status !== 'valid') return result
      const { claims } = result.value
      return {
        status: 'valid',
        value: Object.freeze({
          email: claims.sub.toLowerCase(),
          expiresAt: new Date(claims.exp * 1_000),
          id: claims.jti,
          issuer: claims.iss,
        }),
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Trusted issuer URL. */
    readonly issuer: string
    /** Accepts or rejects (`forbidden`, 403) a verified, lowercased email address. Defaults to any. */
    readonly allow?: ((email: string, request: Request) => MaybePromise<boolean>) | undefined
    /**
     * This server's public origin, such as `https://api.example`, which attestations must be
     * bound to. The function form is deprecated: see `Attestation.Server.verifier.AudienceFunction`.
     */
    readonly audience: string | Attestation.verifier.AudienceFunction
    /** Resolves issuer keys. Defaults to the issuer's JSON Web Key Set. */
    readonly keyResolver?: AttestationTypes.KeyResolver | undefined
    /** Fetch used for the default JSON Web Key Set resolver. */
    readonly fetch?: typeof globalThis.fetch | undefined
    /** Oldest accepted attestation, in seconds since it was issued. Defaults to its own expiry. */
    readonly maxAge?: number | undefined
    /** Clock tolerance in seconds. @default 60 */
    readonly clockTolerance?: number | undefined
  }
}
