import { Base64 } from 'ox'

import { unwrapFetch, withoutPayment } from '../../../../client/internal/Fetch.js'
import * as Credential from '../../../../Credential.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from '../../attestation/client/index.js'
import { Constants as AttestationConstants } from '../../attestation/Constants.js'
import { decode as decodeAttestation, isIssuer, parseHeader } from '../../attestation/Token.js'
import { Constants } from '../Constants.js'
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
    headers: ['dpop', Constants.idTokenHeader.toLowerCase()],
    async prove(request) {
      const accessToken = await config.accessToken()
      const headers = new Headers(request.headers)
      // The access token would replace a Payment Credential in Authorization; a server created
      // with `requiresAuth: true` takes the Credential in Payment-Authorization instead.
      const authorization = headers.get('Authorization')
      if (authorization && Credential.extractPaymentScheme(authorization) !== null)
        throw new TypeError(
          'The Tempo ID access token needs Authorization, which holds the Payment Credential: the server must set requiresAuth: true.',
        )
      headers.set('Authorization', `${dpop ? 'DPoP' : 'Bearer'} ${accessToken}`)
      if (dpop) headers.set('DPoP', await proof(dpop, accessToken, request))
      const idToken = await config.idToken?.()
      if (idToken) headers.set(Constants.idTokenHeader, idToken)
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
    /** Returns the user's ID token, such as `accounts.session.get()?.idToken`, so the API reads their email. */
    readonly idToken?: (() => MaybePromise<string | undefined>) | undefined
    /** Origins that receive the token. Send it only to the API it was issued for. */
    readonly scope: Identity.Prover['scope']
  }
}

/**
 * Creates a prover that presents Tempo ID attestations, obtaining them from a Tempo ID
 * attestation issuer (`TempoId.Issuer`) when a server asks: an `Attestation.Client.prover` whose
 * `acquire` exchanges the user's access token (and ID token, for `email`) at the issuer.
 *
 * Unlike {@link prover}, the access token goes only to the issuer: servers get short-lived
 * attestations bound to their origin, and verify them like any other issuer's.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     TempoId.Client.attestations({
 *       accessToken: () => accounts.session.accessToken(),
 *       idToken: () => accounts.session.get()?.idToken,
 *       issuer: 'https://attest.example',
 *       scope: ['https://api.example'],
 *     }),
 *   ],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function attestations(config: attestations.Config): Identity.Prover {
  assertIssuer(config.issuer)
  // Attestations are cached per signed-in user: when the access token names another user (or
  // none), the cache is dropped, so a new session never presents the previous user's attestations.
  let current: { readonly user: string | undefined; readonly prover: Identity.Prover } | undefined

  function create(user: string | undefined, held: readonly string[] | undefined) {
    return Attestation.prover({
      attestations: held,
      issuers: [config.issuer],
      scope: config.scope,
      types: config.types ?? Constants.attestationTypes,
      async acquire({ audience, issuer, type }) {
        const result = await attest({ ...config, audience, issuer, type })
        if (!result) return undefined
        // Only keep an attestation for the user this cache belongs to.
        const uid = decodeAttestation(result.attestation)?.claims.uid
        return user !== undefined && uid === user ? result.attestation : undefined
      },
    })
  }

  async function resolve() {
    let user: string | undefined
    try {
      const sub = Jwt.decode(await config.accessToken())?.claims.sub
      user = typeof sub === 'string' && sub ? sub : undefined
    } catch {
      // Signed out: no user, so nothing cached is presented.
    }
    if (!current || current.user !== user) {
      // Stored attestations are restored only for the user they name.
      const held = current
        ? undefined
        : config.attestations?.filter(
            (token) => user !== undefined && decodeAttestation(token)?.claims.uid === user,
          )
      current = { user, prover: create(user, held) }
    }
    return current.prover
  }

  return {
    scope: config.scope,
    async prove(request, context) {
      const prover = await resolve()
      // A request already in flight (such as a payment retry) may still carry the previous
      // user's attestations from this issuer: drop every one that names another user.
      const issuer = config.issuer.replace(/\/+$/, '')
      const user = current?.user
      const sent = parseHeader(request.headers.get(AttestationConstants.header))
      const kept = sent.filter((token) => {
        const claims = decodeAttestation(token)?.claims
        return claims?.iss !== issuer || (user !== undefined && claims.uid === user)
      })
      if (kept.length !== sent.length) {
        const headers = new Headers(request.headers)
        if (kept.length > 0) headers.set(AttestationConstants.header, kept.join(', '))
        else headers.delete(AttestationConstants.header)
        request = new Request(request, { headers })
      }
      return prover.prove(request, context)
    },
    async prepare(response, context) {
      return (await resolve()).prepare?.(response, context)
    },
    async retry(response, context) {
      return (await resolve()).retry?.(response, context)
    },
  }
}

export declare namespace attestations {
  type Config = Omit<attest.Parameters, 'audience' | 'type'> & {
    /** Origins that may receive attestations and ask for new ones. */
    readonly scope: Identity.Prover['scope']
    /** Attestation types to obtain. @default ['tempo-id', 'email'] */
    readonly types?: readonly string[] | undefined
    /** Attestations already held, such as from storage. */
    readonly attestations?: readonly string[] | undefined
  }
}

/**
 * Exchanges a Tempo ID access token for one attestation at a Tempo ID attestation issuer.
 * Resolves with `undefined` when the issuer refuses this user that type (403, such as `email`
 * without a verified address), and throws on any other failure.
 */
export async function attest(
  parameters: attest.Parameters,
): Promise<{ readonly attestation: string; readonly expiresAt: Date } | undefined> {
  const { audience, dpop, type } = parameters
  assertIssuer(parameters.issuer)
  const issuer = parameters.issuer.replace(/\/+$/, '')
  const fetch = unwrapFetch(parameters.fetch ?? globalThis.fetch)
  const accessToken = await parameters.accessToken()
  const url = issuer + Constants.attestPath
  const headers = new Headers({
    Authorization: `${dpop ? 'DPoP' : 'Bearer'} ${accessToken}`,
    'Content-Type': 'application/json',
  })
  if (dpop)
    headers.set('DPoP', await proof(dpop, accessToken, new Request(url, { method: 'POST' })))
  // Sent on every exchange: an issuer's `allow` may read the verified email for any type.
  const idToken = await parameters.idToken?.()
  if (idToken) headers.set(Constants.idTokenHeader, idToken)
  // Never pays: an issuer that answers 402 fails the exchange.
  const response = await fetch(
    url,
    withoutPayment({
      body: JSON.stringify({ audience, type }),
      headers,
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout((parameters.timeout ?? 10) * 1_000),
    }),
  )
  const body = (await response.json().catch(() => ({}))) as {
    attestation?: unknown
    error?: unknown
    expires_at?: unknown
  }
  if (response.status === 403) return undefined
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string' ? body.error : `The issuer answered ${response.status}.`,
    )
  if (typeof body.attestation !== 'string' || typeof body.expires_at !== 'string')
    throw new Error('The issuer returned a malformed attestation.')
  return { attestation: body.attestation, expiresAt: new Date(body.expires_at) }
}

export declare namespace attest {
  type Parameters = {
    /** The Tempo ID attestation issuer's URL. */
    readonly issuer: string
    /** Origin of the server the attestation is for. */
    readonly audience: string
    /** Attestation type, such as `tempo-id` or `email`. */
    readonly type: string
    /** Returns a live Tempo ID access token, such as `accounts.session.accessToken`. */
    readonly accessToken: () => MaybePromise<string>
    /** The DPoP key that binds the token. Absent, the token is sent as a Bearer token. */
    readonly dpop?: Types.DpopKey | undefined
    /** Seconds to wait for the issuer before the exchange fails. @default 10 */
    readonly timeout?: number | undefined
    /** Returns the user's ID token, which `email` needs and an issuer's policy may read. */
    readonly idToken?: (() => MaybePromise<string | undefined>) | undefined
    /** Fetch implementation. @default globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch | undefined
  }
}

/** Throws unless `issuer` is https (http only on localhost), since it receives the user's tokens. */
function assertIssuer(issuer: string) {
  if (!isIssuer(issuer.replace(/\/+$/, '')))
    throw new TypeError(
      'The Tempo ID attestation issuer must be an https URL (http only on localhost).',
    )
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
