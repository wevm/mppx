import type { MaybePromise } from '../../../../internal/types.js'
import type * as Store from '../../../../Store.js'
import * as Attestation from '../../attestation/Issuer.js'
import { decode, isIssuer } from '../../attestation/Token.js'
import type { SigningKey } from '../../Types.js'
import { Constants } from '../Constants.js'
import * as Server from '../server/index.js'
import type * as Types from '../Types.js'

/**
 * Creates a Tempo ID attestation issuer: exchanges a signed-in user's Tempo ID access token for
 * `Identity-Attestation` tokens that any MPP server verifies with `Attestation.Server.verifier`,
 * like those of any other issuer.
 *
 * - `tempo-id`: `sub` is the user's Tempo ID user ID.
 * - `email`: `sub` is the user's email address, only when the client sends an ID token
 *   (`Tempo-Id-Token`) and Tempo ID verified the address.
 *
 * Every attestation carries the user ID as `uid`, so a server can tell that attestations of
 * several types name one user, and the app that exchanged the token as `azp`. The access token is checked as `TempoId.Server` checks it,
 * including its DPoP proof, which the client signs for this endpoint.
 *
 * `handle` answers, relative to `url`:
 * - `POST /tempo-id/attest` (`Constants.attestPath`) with `{ audience, type }`: `200`
 *   `{ attestation, expires_at }`; `400`, `401`, `403` or `503` `{ error }`.
 * - `GET /.well-known/jwks.json`: the attestation key.
 *
 * Run it as a shared service many servers trust, or inside an app's own backend.
 *
 * @example
 * ```ts
 * const issuer = TempoId.Issuer.create({
 *   clientId: 'app_…',
 *   signingKey,
 *   store,
 *   url: 'https://attest.example',
 * })
 * // In the fetch handler, before its routes:
 * const answered = await issuer.handle(request)
 * if (answered) return answered
 * ```
 */
export function create(config: create.Config): Issuer {
  const url = config.url.replace(/\/+$/, '')
  if (!isIssuer(url)) throw new TypeError('Tempo ID attestation issuer url must be an https URL.')
  const types = config.types ?? Constants.attestationTypes
  for (const type of types)
    if (!(Constants.attestationTypes as readonly string[]).includes(type))
      throw new TypeError(`Tempo ID attestation issuer cannot sign type "${type}".`)
  const attestation = Attestation.create({
    issuer: url,
    signingKey: config.signingKey,
    ttl: config.ttl,
  })
  if (!config.store)
    throw new TypeError(
      'Tempo ID attestation issuer requires store, so each DPoP proof is accepted once.',
    )
  if (!config.clientId || (Array.isArray(config.clientId) && config.clientId.length === 0))
    throw new TypeError(
      'Tempo ID attestation issuer requires clientId: the apps that may exchange tokens.',
    )
  const tempoId = Server.create({
    allow: config.allow,
    // Only tokens issued for this issuer: a token another API received cannot be exchanged here.
    audience: config.tokenAudience ?? url,
    clientId: config.clientId,
    fetch: config.fetch,
    issuer: config.issuer,
    store: config.store,
  })
  const attestPath = new URL(url).pathname.replace(/\/+$/, '') + Constants.attestPath
  // DPoP proofs must name this issuer's configured endpoint, never one built from the Host header.
  const attestUrl = new URL(url).origin + attestPath

  async function attest(request: Request): Promise<Response> {
    const body = await readJson(request)
    if (body === undefined) return error(400, `The body must be JSON of at most ${maxBody} bytes.`)
    const { audience, type } = (typeof body === 'object' && body !== null ? body : {}) as {
      audience?: unknown
      type?: unknown
    }
    if (typeof audience !== 'string' || audience.length > 2_048 || !isIssuer(audience))
      return error(400, 'audience must be an https origin.')
    if (typeof type !== 'string' || !types.includes(type as Type))
      return error(400, `type must be one of ${types.join(', ')}.`)

    const verified = await tempoId.verifier.verify(
      new Request(attestUrl, { headers: request.headers, method: request.method }),
    )
    if (verified.status !== 'valid')
      return error(statusCodes[verified.status], verified.reason ?? 'Sign in with Tempo ID.', {
        ...(verified.status === 'missing' || verified.status === 'invalid'
          ? Object.fromEntries(new Headers(verified.headers))
          : {}),
      })
    const user = verified.value
    let sub: string
    if (type === 'email') {
      if (!user.email || user.emailVerified !== true)
        return error(403, 'Send an ID token naming an email address Tempo ID verified.')
      sub = user.email
    } else sub = user.userId

    let token: string
    try {
      token = await attestation.sign({
        audience,
        // The app that exchanged the token, so a server can restrict which apps it accepts.
        claims: { azp: user.clientId },
        sub,
        type,
        uid: user.userId,
      })
    } catch {
      return error(400, 'The attestation cannot be signed for this request.')
    }
    const exp = decode(token)?.claims.exp
    if (typeof exp !== 'number')
      return error(400, 'The attestation cannot be signed for this request.')
    return Response.json(
      { attestation: token, expires_at: new Date(exp * 1_000).toISOString() },
      { headers: { ...cors, 'Cache-Control': 'no-store' } },
    )
  }

  return {
    issuer: url,
    keyResolver: attestation.keyResolver,
    jwks: attestation.jwks,
    async handle(request) {
      const { pathname } = new URL(request.url)
      if (pathname === attestPath) {
        if (request.method === 'OPTIONS')
          return new Response(null, {
            status: 204,
            headers: {
              ...cors,
              'Access-Control-Allow-Headers': 'authorization, content-type, dpop, tempo-id-token',
              'Access-Control-Allow-Methods': 'POST',
              'Access-Control-Max-Age': '600',
            },
          })
        if (request.method !== 'POST') return error(405, 'Use POST.', { Allow: 'POST' })
        return attest(request)
      }
      return attestation.handle(request)
    },
  }
}

export declare namespace create {
  type Config = {
    /** This issuer's URL, which attestations carry as `iss`. */
    readonly url: string
    /** Ed25519 key pair, or a remote Signer, that signs attestations. */
    readonly signingKey: SigningKey
    /** Attestation types this issuer signs. @default ['tempo-id', 'email'] */
    readonly types?: readonly Type[] | undefined
    /** Seconds each attestation is valid. @default 3600 */
    readonly ttl?: number | undefined
    /** The app or apps whose access tokens may be exchanged. Required. */
    readonly clientId: string | readonly string[]
    /** Decides whether a verified user may get attestations. */
    readonly allow?: ((user: Types.Payer) => MaybePromise<boolean>) | undefined
    /** Accepts each DPoP proof once. Required, so a captured proof cannot be exchanged again. */
    readonly store: Store.AtomicStore
    /**
     * The audience access tokens must name. Defaults to this issuer's `url`, so a token Tempo ID
     * issued for another API cannot be exchanged here.
     */
    readonly tokenAudience?: string | undefined
    /** Tempo ID's origin. @default 'https://id.tempo.xyz' */
    readonly issuer?: string | undefined
    /** Fetch used for Tempo ID's keys. */
    readonly fetch?: typeof globalThis.fetch | undefined
  }
}

/** An attestation type a Tempo ID attestation issuer signs. */
export type Type = (typeof Constants.attestationTypes)[number]

/** A Tempo ID attestation issuer from {@link create}. */
export type Issuer = {
  /** This issuer's URL, without a trailing slash. */
  readonly issuer: string
  /** Resolves this issuer's key in process, for a server that runs beside it. */
  readonly keyResolver: Attestation.Issuer['keyResolver']
  /** This issuer's JSON Web Key Set. */
  readonly jwks: Attestation.Issuer['jwks']
  /** Answers the issuer's routes, and returns `undefined` for any other request. */
  readonly handle: (request: Request) => Promise<Response | undefined>
}

const cors = { 'Access-Control-Allow-Origin': '*' } as const

/** The largest request body the issuer reads, in bytes. */
const maxBody = 4_096

/**
 * Reads a JSON body of at most {@link maxBody} bytes before anything else runs, cancelling the
 * stream once it is over, or returns `undefined`.
 */
async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBody) return undefined
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBody) {
        reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

const statusCodes = { missing: 401, invalid: 401, forbidden: 403, unavailable: 503 } as const

function error(status: number, message: string, headers: Record<string, string> = {}) {
  return Response.json({ error: message }, { status, headers: { ...cors, ...headers } })
}
