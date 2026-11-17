import { Address } from 'ox'

import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import * as Store from '../../../../Store.js'
import { Constants } from '../Constants.js'
import * as Jwt from '../internal/Jwt.js'
import type * as Types from '../Types.js'

/**
 * Creates a Tempo ID verifier for one API.
 *
 * - `verifier` requires a valid Tempo ID access token from an allowed app.
 * - `paymentCheck` also requires a `tempo` payment whose `source` is a Tempo Account the token
 *   grants to the app, so one user's token cannot pay with another user's wallet.
 *   It refuses an account that Tempo ID screened as anything but `clear`.
 *
 * Tokens verify offline against Tempo ID's keys. A DPoP-bound token also needs a proof of its key
 * for the request, which `store` accepts once. The token uses `Authorization`, so create the
 * server with `requiresAuth: true`.
 *
 * @example
 * ```ts
 * const tempoId = TempoId.Server.create({ clientId: 'app_…', store })
 * const mppx = Mppx.create({ methods: [tempo({ … })], requiresAuth: true, secretKey })
 *
 * mppx.charge({ amount: '0.01', identity: { payment: tempoId.paymentCheck } })
 * ```
 *
 * `allow` receives the user's ID, app, accounts with their compliance states, the email address
 * from the ID token the client sends in `Tempo-Id-Token`, and, on the paid retry, the paying account:
 *
 * ```ts
 * TempoId.Server.create({
 *   allow: (user) =>
 *     user.emailVerified === true &&
 *     user.email?.endsWith('@example.com') === true,
 *   clientId: 'app_…',
 * })
 * ```
 */
export function create(config: create.Config): TempoId {
  const { chainId = 4217, store } = config
  const issuer = new URL(config.issuer ?? Constants.issuer).origin
  const audience = config.audience ?? issuer
  // Absent, any app's token passes; `allow` can still decide by `clientId`.
  const clientIds = config.clientId === undefined ? undefined : [config.clientId].flat()
  const keys = Jwt.keys(issuer, unwrapFetch(config.fetch ?? globalThis.fetch))
  // One verification per request, so a DPoP proof is spent once across both checks.
  const verified = new WeakMap<Request, Promise<Identity.Verification<Types.Caller>>>()

  const headers = { 'WWW-Authenticate': 'DPoP algs="ES256", Bearer' }
  const invalid = (reason: string) => ({ status: 'invalid', headers, reason }) as const

  async function check(request: Request): Promise<Identity.Verification<Types.Caller>> {
    // RFC 9110: one or more spaces separate the scheme and the token.
    const [, scheme = '', token = ''] =
      /^(\S+) +(\S+) *$/.exec(request.headers.get('Authorization') ?? '') ?? []
    const dpop = scheme.toLowerCase() === 'dpop'
    if (!token || (!dpop && scheme.toLowerCase() !== 'bearer'))
      return { status: 'missing', headers, reason: 'Sign in with Tempo ID.' }

    const jwt = Jwt.decode(token)
    if (!jwt || jwt.header.typ !== 'at+jwt')
      return invalid('The token is not a Tempo ID access token.')
    const signed = await signedByTempoId(jwt)
    if (signed === 'unavailable')
      return { status: 'unavailable', reason: "Tempo ID's signing keys are unavailable." }
    if (!signed) return invalid('The access token signature is invalid.')

    const { aud, client_id, cnf, exp, iss, nbf, sub } = jwt.claims
    const now = Math.floor(Date.now() / 1_000)
    // A token that also names another API is that API's too, so only our audience (and Tempo ID's userinfo) passes.
    const audiences = [aud].flat()
    if (iss !== issuer || typeof sub !== 'string')
      return invalid('The access token is not from Tempo ID.')
    if (
      !audiences.includes(audience) ||
      audiences.some((a) => a !== audience && a !== `${issuer}/oauth2/userinfo`)
    )
      return invalid('The access token is for another API.')
    if (typeof exp !== 'number' || exp + Constants.clockTolerance <= now)
      return invalid('The access token has expired.')
    if (nbf !== undefined && (typeof nbf !== 'number' || nbf > now + Constants.clockTolerance))
      return invalid('The access token is not valid yet.')
    if (typeof client_id !== 'string' || (clientIds && !clientIds.includes(client_id)))
      return { status: 'forbidden', reason: 'This app may not call this API.' }

    // RFC 9449: a DPoP-bound token is useless without a proof from its key, and a Bearer token takes none.
    if (dpop !== (cnf?.jkt !== undefined))
      return invalid('The access token scheme does not match its binding.')
    if (dpop) {
      // A replay store failure rejects, so the proof cannot be spent once.
      const reason = await checkProof(request, { jkt: cnf.jkt, now, token }).catch(() => null)
      if (reason === null)
        return { status: 'unavailable', reason: 'The DPoP replay store is unavailable.' }
      if (reason) return invalid(reason)
    }

    const accounts = [...(jwt.claims.access_keys ?? [])]
      .filter((entry) => entry?.chain_id === chainId && isAddress(entry.account))
      .map((entry) => entry.account)
      .concat((jwt.claims.tempo_accounts ?? []).filter(isAddress))
      .map((account: string) => Address.checksum(account))
    const compliance = Object.fromEntries(
      Object.entries(jwt.claims.compliance ?? {}).map(([address, state]) => [
        Address.checksum(address),
        state,
      ]),
    ) as Types.Caller['compliance']

    const idToken = await checkIdToken(request, { clientId: client_id, now, sub })
    if (typeof idToken === 'string') return invalid(idToken)
    if (idToken === null)
      return { status: 'unavailable', reason: "Tempo ID's signing keys are unavailable." }

    return {
      status: 'valid',
      value: {
        accounts: [...new Set(accounts)],
        clientId: client_id,
        compliance,
        ...idToken,
        userId: sub,
      },
    }
  }

  /** Returns whether Tempo ID's RS256 keys signed a JWS, or `'unavailable'` when they cannot be read. */
  async function signedByTempoId(jwt: Jwt.Decoded): Promise<boolean | 'unavailable'> {
    if (jwt.header.alg !== 'RS256') return false
    let key: CryptoKey | undefined
    try {
      key = await keys(String(jwt.header.kid))
    } catch {
      return 'unavailable'
    }
    if (!key) return false
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, jwt.signingInput)
  }

  /**
   * Reads the email of the request's ID token, which Tempo ID issues to the same app for the same
   * user. Returns why it fails, `null` when the keys are unavailable, or no email without a token.
   */
  async function checkIdToken(
    request: Request,
    options: { clientId: string; now: number; sub: string },
  ): Promise<Pick<Types.Caller, 'email' | 'emailVerified'> | string | null> {
    const value = request.headers.get(Constants.idTokenHeader)
    if (!value) return {}
    const jwt = Jwt.decode(value)
    if (!jwt) return 'The ID token is malformed.'
    const signed = await signedByTempoId(jwt)
    if (signed === 'unavailable') return null
    if (!signed) return 'The ID token signature is invalid.'
    const { aud, email, email_verified, exp, iss, sub } = jwt.claims
    if (iss !== issuer || ![aud].flat().includes(options.clientId) || sub !== options.sub)
      return 'The ID token is for another user or app.'
    // An expired ID token names no email, so `allow` decides without it.
    if (typeof exp !== 'number' || exp + Constants.clockTolerance <= options.now) return {}
    if (typeof email !== 'string') return {}
    return { email: email.toLowerCase(), emailVerified: email_verified === true }
  }

  /** Runs `allow` on a verified user or payer. */
  async function allowed<value extends Types.Payer>(
    result: Identity.Verification<value>,
  ): Promise<Identity.Verification<value>> {
    if (result.status !== 'valid' || !config.allow || (await config.allow(result.value)))
      return result
    return { status: 'forbidden', reason: 'This user may not call this API.' }
  }

  /** Returns why a request's DPoP proof fails, or `undefined`. */
  async function checkProof(
    request: Request,
    options: { jkt: string; now: number; token: string },
  ) {
    const proof = Jwt.decode(request.headers.get('DPoP') ?? '')
    if (!proof || proof.header.alg !== 'ES256' || proof.header.typ !== 'dpop+jwt')
      return 'The DPoP proof is malformed.'
    const jwk = proof.header.jwk as JsonWebKey
    if (
      !jwk ||
      typeof jwk !== 'object' ||
      'd' in jwk ||
      (await Jwt.thumbprint(jwk)) !== options.jkt
    )
      return 'The DPoP proof key does not bind the token.'
    const valid = await crypto.subtle
      .importKey('jwk', jwk, Jwt.es256.key, false, ['verify'])
      .then((key) => crypto.subtle.verify(Jwt.es256.sign, key, proof.signature, proof.signingInput))
      .catch(() => false)
    if (!valid) return 'The DPoP proof signature is invalid.'

    const { ath, htm, htu, iat, jti } = proof.claims
    if (htm !== request.method || htu !== Jwt.htu(request.url))
      return 'The DPoP proof is for another request.'
    if (ath !== (await Jwt.sha256(options.token))) return 'The DPoP proof is for another token.'
    if (typeof iat !== 'number') return 'The DPoP proof has expired.'
    const expires = iat + Constants.proofMaxAge + Constants.clockTolerance
    if (iat > options.now + Constants.clockTolerance || expires < options.now)
      return 'The DPoP proof has expired.'
    if (typeof jti !== 'string' || !jti) return 'The DPoP proof has no ID.'
    if (
      store &&
      !(await Store.tryClaim(
        store,
        `mppx:tempo-id:dpop:${await Jwt.sha256(`${options.jkt}:${jti}`)}`,
        expires * 1_000,
      ))
    )
      return 'The DPoP proof was already used.'
    return undefined
  }

  function verify(request: Request) {
    let result = verified.get(request)
    if (!result) verified.set(request, (result = check(request)))
    return result
  }

  return {
    verifier: { authorization: true, verify: async (request) => allowed(await verify(request)) },
    paymentCheck: {
      authorization: true,
      requires: [{ type: Constants.type, issuer }],
      async verify(parameters): Promise<Identity.Verification<Types.Payer>> {
        const caller = await verify(parameters.request)
        if (caller.status !== 'valid' || !parameters.credential) return allowed(caller)
        // Only the tempo method checks the source against the transaction's sender.
        if (parameters.challenge.method !== 'tempo')
          return { status: 'forbidden', reason: 'Pay with the tempo method.' }
        // A Zone payment does not bind its source to the paying account.
        if ((parameters.credential.payload as { type?: unknown } | undefined)?.type === 'zone')
          return { status: 'forbidden', reason: 'Pay from a Tempo account, not a Zone.' }
        // The source is a did:pkh:eip155:<chainId>:<address>.
        const parts = parameters.credential.source?.split(':') ?? []
        const [did, pkh, namespace, chain, address] = parts
        if (
          parts.length !== 5 ||
          did !== 'did' ||
          pkh !== 'pkh' ||
          namespace !== 'eip155' ||
          chain !== String(chainId) ||
          !isAddress(address)
        )
          return {
            status: 'invalid',
            reason: `The payment must name its source account on chain ${chainId}.`,
          }
        const account = Address.checksum(address)
        if (!caller.value.accounts.includes(account))
          return {
            status: 'forbidden',
            reason: 'The paying account is not one this user granted to the app.',
          }
        const state = caller.value.compliance[account]
        // Tempo ID screens the accounts in a registered app's realms; only a clear one pays.
        if (state !== undefined && state !== 'clear')
          return { status: 'forbidden', reason: 'The paying account is not cleared to pay.' }
        return allowed({ status: 'valid', value: { ...caller.value, account } })
      },
    },
  }
}

export declare namespace create {
  type Config = {
    /**
     * Decides whether a verified user may call the API, such as by email or by the paying
     * account's compliance state. On the paid retry it also receives the paying `account`.
     */
    readonly allow?: ((user: Types.Payer) => boolean | Promise<boolean>) | undefined
    /** The chain payments settle on. @default 4217 (Tempo mainnet) */
    readonly chainId?: number | undefined
    /** The app or apps whose tokens the API accepts. @default any app */
    readonly clientId?: string | readonly string[] | undefined
    /** Accepts each DPoP proof once. Without it, a proof can be replayed for five minutes. */
    readonly store?: Store.AtomicStore | undefined
    /** The audience tokens must name. @default the issuer's origin */
    readonly audience?: string | undefined
    /** Tempo ID's origin. @default 'https://id.tempo.xyz' */
    readonly issuer?: string | undefined
    /** Fetch used for Tempo ID's keys. */
    readonly fetch?: typeof globalThis.fetch | undefined
  }
}

/** A Tempo ID verifier from {@link create}. */
export type TempoId = {
  /** A request-stage verifier: requires a Tempo ID access token before any 402. */
  readonly verifier: Identity.Verifier<Types.Caller>
  /** A payment check: requires a Tempo ID access token, and that the payer is one of its accounts. */
  readonly paymentCheck: Identity.PaymentCheck<Types.Payer>
}

function isAddress(value: unknown): value is Address.Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}
