import type * as Identity from '../../../../identity/Types.js'
import * as Attestation from '../../attestation/server/index.js'
import type * as AttestationTypes from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a request-stage verifier that requires a human verified with World ID: an
 * `Attestation.Server.verifier` of type `world-id` from a shared World ID issuer.
 *
 * A request without one gets 401 with `Identity-Attestation-Required: world-id;issuer="…"`. The
 * client runs World IdP's device flow through the issuer, which holds the World IdP client, and
 * sends the attestation in `Identity-Attestation`. This server never calls World IdP and hosts no
 * routes. An attestation whose `acr` is not in `acr` is `forbidden` (403).
 *
 * @example
 * ```ts
 * const human = World.Server.verifier({
 *   audience: 'https://api.example',
 *   issuer: 'https://world-id.issuer.example',
 * })
 * const result = await mppx.charge({ amount: '1', identity: [human] })(request)
 * if (result.status === 200) result.identity?.get(human)?.subject
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedHuman> {
  const acr = config.acr
  if (acr && acr.length === 0) throw new TypeError('World ID verifier requires at least one acr.')
  const inner = Attestation.verifier({
    audience: config.audience,
    clockTolerance: config.clockTolerance,
    fetch: config.fetch,
    issuer: config.issuer,
    keyResolver: config.keyResolver,
    maxAge: config.maxAge,
    type: Constants.type,
    ...(acr && {
      validate(claims) {
        const value = (claims as { acr?: unknown }).acr
        if (typeof value === 'string' && acr.includes(value)) return undefined
        return 'This World ID verification level is not accepted.'
      },
    }),
  })
  return {
    async verify(request) {
      const result = await inner.verify(request)
      if (result.status !== 'valid') return result
      const { claims } = result.value
      const value = (claims as { acr?: unknown }).acr
      return {
        status: 'valid',
        value: Object.freeze({
          ...(typeof value === 'string' && { acr: value }),
          expiresAt: new Date(claims.exp * 1_000),
          id: claims.jti,
          issuer: claims.iss,
          subject: claims.sub,
        }),
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Trusted World ID issuer URL. */
    readonly issuer: string
    /**
     * This server's public origin, such as `https://api.example`, which attestations must be
     * bound to. The function form is deprecated: see `Attestation.Server.verifier.AudienceFunction`.
     */
    readonly audience: string | Attestation.verifier.AudienceFunction
    /**
     * Accepted World IdP authentication classes (`Constants.acr`). Defaults to any the issuer
     * attests.
     */
    readonly acr?: readonly string[] | undefined
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
