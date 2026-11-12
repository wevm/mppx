import { Base64 } from 'ox'

import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Jwt from '../internal/Jwt.js'
import type * as Types from '../Types.js'

/**
 * Creates a prover that sends a Tempo ID access token with each request: as `DPoP` with a new
 * proof when `dpop` is set, else as `Bearer`.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     TempoId.Client.prover({
 *       accessToken: () => accounts.session.accessToken(),
 *       scope: ['https://api.example'],
 *     }),
 *   ],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const { dpop } = config
  return {
    scope: config.scope,
    headers: ['dpop'],
    async prove(request) {
      const accessToken = await config.accessToken()
      const headers = new Headers(request.headers)
      headers.set('Authorization', `${dpop ? 'DPoP' : 'Bearer'} ${accessToken}`)
      if (dpop) headers.set('DPoP', await proof(dpop, accessToken, request))
      return new Request(request, { headers })
    },
  }
}

export declare namespace prover {
  type Config = {
    /** Returns a live Tempo ID access token, such as `accounts.session.accessToken`. */
    readonly accessToken: () => MaybePromise<string>
    /** The DPoP key that binds the token. Absent, the token is sent as a Bearer token. */
    readonly dpop?: Types.DpopKey | undefined
    /** Origins that receive the token. Send it only to the API it was issued for. */
    readonly scope: Identity.Prover['scope']
  }
}

/** Signs a DPoP proof (RFC 9449) of `accessToken` for one request. */
async function proof(dpop: Types.DpopKey, accessToken: string, request: Request) {
  const { crv, kty, x, y } = dpop.jwk
  const header = Jwt.encode({ alg: 'ES256', jwk: { crv, kty, x, y }, typ: 'dpop+jwt' })
  const claims = Jwt.encode({
    ath: await Jwt.sha256(accessToken),
    htm: request.method,
    htu: Jwt.htu(request.url),
    iat: Math.floor(Date.now() / 1_000),
    jti: crypto.randomUUID(),
  })
  const input = `${header}.${claims}`
  const signature = await crypto.subtle.sign(
    Jwt.es256.sign,
    dpop.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
}
