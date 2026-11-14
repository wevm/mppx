import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Jwt from '../../tempo/internal/Jwt.js'
import { Constants } from '../Constants.js'
import * as Jws from '../internal/Jws.js'
import type * as Types from '../Types.js'

/**
 * Creates a prover that sends a Poppy `Poppy-Session` header with each request to one Company.
 *
 * A Session JWT is signed fresh for every attempt, including the paid retry, so it names the
 * request's method and URL and, when the request carries an OAuth access token, binds to it with
 * `ath`. The Payment Credential is not an access token: it is never bound.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     Poppy.Client.prover({
 *       audience: 'https://api.example.com',
 *       clientId: 'https://agent.example/agent.json',
 *       delegation: () => delegations.current(),
 *       key: delegatedKey,
 *       scope: ['https://api.example.com'],
 *       userId: 'usr_Q7c1vK',
 *     }),
 *   ],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const sessionId = config.sessionId ?? crypto.randomUUID().replaceAll('-', '')
  let kid: Promise<string> | undefined
  return {
    scope: config.scope,
    headers: [Constants.sessionHeader.toLowerCase()],
    async prove(request) {
      const headers = new Headers(request.headers)
      const token = Jws.accessToken(headers)
      const session = await Jws.sign(
        {
          alg: 'ES256',
          kid: await (kid ??= Jwt.thumbprint(config.key.jwk)),
          poppy_dlg: await config.delegation(),
          typ: Constants.sessionType,
        },
        {
          ...(config.agentId && { agent_id: config.agentId }),
          ...(token && { ath: await Jwt.sha256(token) }),
          aud: config.audience,
          htm: request.method,
          htu: Jwt.htu(request.url),
          iat: Math.floor(Date.now() / 1_000),
          iss: config.clientId,
          jti: crypto.randomUUID(),
          sid: sessionId,
          sub: config.userId,
        },
        config.key.privateKey,
      )
      headers.set(Constants.sessionHeader, session)
      headers.set(Constants.versionHeader, Constants.version)
      return new Request(request, { headers })
    },
  }
}

export declare namespace prover {
  type Config = {
    /** The Company's identifier: its OAuth issuer, or `https://{organization.domain}`. */
    readonly audience: string
    /** The Personal Agent's `client_id`, the HTTPS URL of its client metadata document. */
    readonly clientId: string
    /** Returns a current delegation for `key`, signed by a key in the agent's `jwks_uri`. */
    readonly delegation: () => MaybePromise<string>
    /** The delegated key that signs Session JWTs. Use it for this User ID only. */
    readonly key: Types.DelegatedKey
    /** Origins of this Company that receive the header. */
    readonly scope: Identity.Prover['scope']
    /** The User ID for this Company: stable, opaque and not derived from personal information. */
    readonly userId: string
    /** The optional Agent ID, for a Personal Agent that runs several agents for the User. */
    readonly agentId?: string | undefined
    /** The Session ID. @default a random ID per prover */
    readonly sessionId?: string | undefined
  }
}

/**
 * Signs a delegation (spec 5.2): a short-lived JWT in which a key from the agent's `jwks_uri`
 * vouches for a delegated key. It names no User or Company.
 */
export function delegate(parameters: delegate.Parameters): Promise<string> {
  const { clientId, expiresIn = Constants.defaultDelegationLifetime, key, publicKey } = parameters
  if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > Constants.maxDelegationLifetime)
    throw new RangeError('A delegation lasts between 1 second and 24 hours.')
  const { crv, kty, x, y } = publicKey
  const iat = Math.floor(Date.now() / 1_000)
  return Jws.sign(
    { alg: 'ES256', kid: key.kid, typ: Constants.delegationType },
    {
      cnf: { jwk: { crv, kty, x, y } },
      exp: iat + expiresIn,
      iat,
      iss: clientId,
      jti: crypto.randomUUID(),
    },
    key.privateKey,
  )
}

export declare namespace delegate {
  type Parameters = {
    /** The Personal Agent's `client_id`. */
    readonly clientId: string
    /** The ES256 key from `jwks_uri` that signs the delegation, with its `kid`. */
    readonly key: { readonly kid: string; readonly privateKey: CryptoKey }
    /** The delegated public key. */
    readonly publicKey: JsonWebKey
    /** Lifetime in seconds, at most 24 hours. @default 3600 */
    readonly expiresIn?: number | undefined
  }
}
