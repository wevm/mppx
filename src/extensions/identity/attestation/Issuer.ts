import * as JwkThumbprint from '../internal/JwkThumbprint.js'
import * as Signer from '../internal/Signer.js'
import type { SigningKey } from '../Types.js'
import { Constants } from './Constants.js'
import { isIssuer, sign as signToken } from './Token.js'
import type * as Types from './Types.js'

/**
 * Creates an attestation issuer: signs audience-bound `Identity-Attestation` tokens with one
 * Ed25519 key and publishes that key as a JSON Web Key Set.
 *
 * It is the building block for any identity provider that already knows who its user is (an
 * OpenID Connect sign-in, a wallet service, Tempo ID): after its own check, it calls `sign` with
 * the fact it verified, one attestation per type, and serves `handle` so servers can fetch its
 * key. `signingKey` may be a {@link SigningKey | Signer} whose private key stays in a KMS, HSM or
 * wallet service.
 *
 * @example
 * ```ts
 * const issuer = Attestation.Issuer.create({ issuer: 'https://issuer.example', signingKey })
 *
 * // After the user signed in with GitHub:
 * const attestation = await issuer.sign({
 *   audience: 'https://api.example',
 *   type: 'github',
 *   sub: String(user.id),
 *   handle: user.login,
 *   uid: user.accountId,
 * })
 *
 * // In the issuer's fetch handler, before its routes:
 * const answered = await issuer.handle(request)
 * if (answered) return answered
 * ```
 */
export function create(config: create.Config): Issuer {
  const issuer = config.issuer.replace(/\/+$/, '')
  if (!isIssuer(issuer))
    throw new TypeError('Attestation issuer must be an https URL (http only on localhost).')
  const ttl = config.ttl ?? defaultTtl
  if (!isTtl(ttl))
    throw new TypeError('Attestation issuer ttl must be a positive integer of seconds.')
  const { publicKey } = Signer.resolve(config.signingKey, ['ed25519'])
  const jwksPath = new URL(issuer).pathname.replace(/\/+$/, '') + Constants.jwksPath
  const key = (async () => {
    const keyId = config.keyId ?? (await JwkThumbprint.fromKey(publicKey))
    const { crv, kty, x } = await crypto.subtle.exportKey('jwk', publicKey)
    if (kty !== 'OKP' || crv !== 'Ed25519' || !x)
      throw new TypeError('Attestation issuer signingKey must be an Ed25519 key.')
    const jwk = Object.freeze({ alg: Constants.algorithm, crv, kid: keyId, kty, use: 'sig', x })
    return { jwk, keyId }
  })()
  // Fails on the first call rather than as an unhandled rejection.
  key.catch(() => {})

  return {
    issuer,
    async sign(parameters) {
      const { audience, handle, sub, type, uid, cnf, claims } = parameters
      if (!isIssuer(audience))
        throw new TypeError(
          'Attestation audience must be an https origin (http only on localhost).',
        )
      if (!isType(type)) throw new TypeError('Attestation type must be a structured-field token.')
      if (typeof sub !== 'string' || sub === '')
        throw new TypeError('Attestation subject must be a non-empty string.')
      const lifetime = parameters.ttl ?? ttl
      if (!isTtl(lifetime))
        throw new TypeError('Attestation ttl must be a positive integer of seconds.')
      if (uid !== undefined && (typeof uid !== 'string' || uid === ''))
        throw new TypeError('Attestation uid must be a non-empty string.')
      if (handle !== undefined && typeof handle !== 'string')
        throw new TypeError('Attestation handle must be a string.')
      if (cnf !== undefined && !isConfirmation(cnf))
        throw new TypeError('Attestation cnf must be an object whose jkt and addr are strings.')
      if (
        claims !== undefined &&
        (typeof claims !== 'object' || claims === null || Array.isArray(claims))
      )
        throw new TypeError('Attestation claims must be an object.')
      const now = Math.floor(Date.now() / 1_000)
      const payload = {
        ...claims,
        ...(uid !== undefined && { uid }),
        ...(handle !== undefined && { handle }),
        ...(cnf !== undefined && { cnf }),
        aud: new URL(audience).origin,
        exp: now + lifetime,
        iat: now,
        iss: issuer,
        jti: crypto.randomUUID(),
        sub,
        type,
      }
      // Extra claims may carry uid, handle or cnf too: check what is signed, as verify will.
      if (payload.uid !== undefined && (typeof payload.uid !== 'string' || payload.uid === ''))
        throw new TypeError('Attestation uid must be a non-empty string.')
      if (payload.handle !== undefined && typeof payload.handle !== 'string')
        throw new TypeError('Attestation handle must be a string.')
      if (payload.cnf !== undefined && !isConfirmation(payload.cnf))
        throw new TypeError('Attestation cnf must be an object whose jkt and addr are strings.')
      const { keyId } = await key
      const token = await signToken(payload as Types.Claims, { key: config.signingKey, keyId })
      // Servers reject longer tokens, so never hand one out.
      if (token.length > Constants.maxLength)
        throw new TypeError(`Attestation is longer than ${Constants.maxLength} characters.`)
      return token
    },
    async jwks() {
      return { keys: [(await key).jwk] }
    },
    async keyResolver({ issuer: claimed, keyId }) {
      const current = await key
      if (claimed.replace(/\/+$/, '') !== issuer || keyId !== current.keyId) return undefined
      return publicKey
    },
    async handle(request) {
      if (new URL(request.url).pathname !== jwksPath) return undefined
      if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
      return Response.json(
        { keys: [(await key).jwk] },
        {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
          },
        },
      )
    },
  }
}

export declare namespace create {
  type Config = {
    /** This issuer's URL, which attestations carry as `iss` and servers trust by name. */
    readonly issuer: string
    /** Ed25519 key pair, or a remote {@link SigningKey | Signer}, that signs attestations. */
    readonly signingKey: SigningKey
    /** Key identifier. @default the RFC 7638 thumbprint of the public key */
    readonly keyId?: string | undefined
    /** Seconds each attestation is valid. @default 3600 */
    readonly ttl?: number | undefined
  }
}

/** An attestation issuer from {@link create}. */
export type Issuer = {
  /** This issuer's URL, without a trailing slash. */
  readonly issuer: string
  /**
   * Signs one attestation for `audience`. Call it only after checking the fact it states:
   * servers trust it because they trust this issuer.
   */
  readonly sign: (parameters: SignParameters) => Promise<string>
  /** This issuer's JSON Web Key Set. */
  readonly jwks: () => Promise<{ readonly keys: readonly JsonWebKey[] }>
  /** Resolves this issuer's key in process, for a server that runs beside it. */
  readonly keyResolver: Types.KeyResolver
  /**
   * Answers `GET <issuer path>/.well-known/jwks.json` with the key set, and returns `undefined`
   * for every other request.
   */
  readonly handle: (request: Request) => Promise<Response | undefined>
}

/** What {@link Issuer.sign} attests. */
export type SignParameters = {
  /** Origin of the server the attestation is for, such as `https://api.example`. */
  readonly audience: string
  /** Attestation type, such as `email` or `github`. */
  readonly type: string
  /** The attested subject: an address, or the provider's stable account identifier. */
  readonly sub: string
  /** The issuer's identifier for the user, shared by all of their attestations. */
  readonly uid?: string | undefined
  /** A display name for the subject, such as a GitHub login. */
  readonly handle?: string | undefined
  /** What the attestation is bound to (RFC 7800). */
  readonly cnf?: Types.Confirmation | undefined
  /** Other claims to include. Registered claims (`iss`, `aud`, `sub`, `type`, times) win. */
  readonly claims?: Readonly<Record<string, unknown>> | undefined
  /** Seconds this attestation is valid, instead of the issuer's `ttl`. */
  readonly ttl?: number | undefined
}

/** Whether a value can be sent as a structured-field token in `Identity-Attestation-Required`. */
function isType(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*$/.test(value)
}

/** Whether a value is a usable attestation lifetime: a positive integer of seconds, at most a year. */
function isTtl(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 31_536_000
  )
}

/** Whether a value is a `cnf` object whose `jkt` and `addr`, when present, are strings. */
export function isConfirmation(value: unknown): value is Types.Confirmation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { addr, jkt } = value as Record<string, unknown>
  return (
    (jkt === undefined || typeof jkt === 'string') &&
    (addr === undefined || typeof addr === 'string')
  )
}

/** Default attestation lifetime, in seconds. */
const defaultTtl = 3_600
