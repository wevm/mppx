import { Base64, Bytes } from 'ox'

import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'
import { presentationVerifier } from './Presentations.js'
import { tokenVerifier } from './Tokens.js'

export { presentationVerifier } from './Presentations.js'
export { tokenVerifier } from './Tokens.js'

/**
 * Creates a request-stage verifier that requires a Link Agent Attestation Token: proof that
 * Link vouches for the agent, with no personal details.
 *
 * A request without one gets 401 with Link's `WWW-Authenticate: PrivateToken` challenge. The
 * token travels in `Authorization`, so create the server with `requiresAuth: true`: Payment
 * credentials then use `Payment-Authorization` and the token stays on the paid retry.
 *
 * Tokens are bearer tokens: the verifier does not make them single use, and a valid one only
 * says Link issued it. Tokens are checked with {@link tokenVerifier}, which needs only Web
 * Crypto, unless `verifier` is set, such as to a `LinkVerifier` from `@stripe/agent-identity`
 * on Node.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({ methods, requiresAuth: true })
 * const result = await mppx.charge({ amount: '1', identity: [Link.Server.attestation()] })(request)
 * ```
 */
export function attestation(
  config: attestation.Config = {},
): Identity.Verifier<Types.VerifiedAttestation> {
  const verifier = config.verifier ?? tokenVerifier()

  async function challenge(
    status: 'missing' | 'invalid',
    reason: string,
  ): Promise<Exclude<Identity.Verification, { status: 'valid' }>> {
    try {
      const { wwwAuthenticate } = await verifier.attestationChallenge()
      return {
        status,
        reason,
        headers: wwwAuthenticate.map((value) => ['WWW-Authenticate', value]),
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `Link is unavailable: ${error instanceof Error ? error.message : error}`,
      }
    }
  }

  return {
    async verify(request) {
      const authorization = request.headers.get('Authorization')
      if (!authorization || !hasScheme(authorization, Constants.attestationScheme))
        return challenge(
          'missing',
          authorization && hasScheme(authorization, 'Payment')
            ? 'A Link attestation needs Authorization: create the server with requiresAuth: true.'
            : 'A Link attestation is required.',
        )
      const result = await verifier.verifyAttestation(authorization)
      if (result.valid)
        return {
          status: 'valid',
          value: Object.freeze({ issuer: result.issuer, tokenKeyId: result.tokenKeyId }),
        }
      if (unavailable(result.failures))
        return { status: 'unavailable', reason: reason(result.failures, 'Link is unavailable.') }
      return challenge('invalid', reason(result.failures, 'The Link attestation is invalid.'))
    },
  }
}

export declare namespace attestation {
  type Config = {
    /**
     * Verifies tokens, shared by every request: a `LinkVerifier` from `@stripe/agent-identity`, or
     * {@link tokenVerifier} with options. @default tokenVerifier()
     */
    readonly verifier?: Types.AttestationVerifier | undefined
  }
}

/**
 * Creates a request-stage verifier that requires claims Link signed, such as a verified email,
 * presented by the credential holder for this server.
 *
 * A request without a presentation gets 401 with `WWW-Authenticate: Identity-Presentation` and
 * Link's `urn:stripe:link:claims-required` problem body, whose nonce is signed with
 * `secretKey` and expires after {@link Constants.nonceTtl} seconds, so no state is kept. The
 * client presents the claims bound to `audience` and that nonce in `Identity-Presentation`.
 * A presentation verifies again until its nonce expires, including on the paid retry.
 *
 * List it before other verifiers of the route: the rejection body is the first rejecting
 * verifier's, and the client needs this one's.
 *
 * @example
 * ```ts
 * const email = Link.Server.claims({
 *   audience: 'https://api.example',
 *   claims: ['email', 'email_verified'],
 *   purpose: 'Write a haiku about you',
 *   secretKey: env.MPP_SECRET_KEY,
 *   verifier: link,
 * })
 * if (result.status === 200) result.identity?.get(email)?.email
 * ```
 */
export function claims(config: claims.Config): Identity.Verifier<Types.VerifiedClaims> {
  const { allow, audience, purpose } = config
  const verifier = config.verifier ?? presentationVerifier({ audience, issuer: config.issuer })
  const required = [...config.claims]
  if (required.length === 0) throw new TypeError('Link claims needs at least one claim.')
  const ttl = config.nonceTtl ?? Constants.nonceTtl
  const key = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  // Binds a nonce to this verifier's audience and claims.
  const context = (expires: string, random: string) =>
    new TextEncoder().encode(
      ['mppx/link-claims', audience, required.join(' '), expires, random].join('\n'),
    )

  async function nonce(): Promise<string> {
    const expires = String(Math.floor(Date.now() / 1_000) + ttl)
    const random = Base64.fromBytes(Bytes.random(16), { url: true, pad: false })
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', await key, context(expires, random)),
    )
    return [expires, random, Base64.fromBytes(mac, { url: true, pad: false })].join('.')
  }

  /** Returns `value` when it is a nonce this verifier issued that has not expired. */
  async function issued(value: unknown): Promise<string | undefined> {
    if (typeof value !== 'string') return undefined
    const [expires, random, mac, ...rest] = value.split('.')
    if (!expires || !random || !mac || rest.length > 0 || !/^\d{1,12}$/.test(expires))
      return undefined
    if (Number(expires) < Date.now() / 1_000) return undefined
    try {
      const signature = Uint8Array.from(Base64.toBytes(mac))
      const valid = await crypto.subtle.verify(
        'HMAC',
        await key,
        signature,
        context(expires, random),
      )
      return valid ? value : undefined
    } catch {
      return undefined
    }
  }

  async function challenge(
    status: 'missing' | 'invalid',
    detail: string,
  ): Promise<Exclude<Identity.Verification, { status: 'valid' }>> {
    const body = {
      type: Constants.claimsRequiredType,
      aud: audience,
      nonce: await nonce(),
      claims: required,
      ...(purpose && { purpose }),
      formats: [Constants.format],
      trusted_issuers: [config.issuer ?? Constants.issuer],
      detail,
    } satisfies Types.ClaimsChallenge & { detail: string }
    return {
      status,
      reason: JSON.stringify(body),
      headers: [
        ['WWW-Authenticate', Constants.presentationHeader],
        ['Content-Type', 'application/problem+json'],
      ],
    }
  }

  return {
    async verify(request) {
      const presentation = request.headers.get(Constants.presentationHeader)
      if (!presentation) return challenge('missing', 'Link identity claims are required.')
      const presented = await issued(nonceOf(presentation))
      if (!presented) return challenge('invalid', 'The presentation nonce is unknown or expired.')
      const result = await verifier.verifyClaims(presentation, {
        nonce: presented,
        requiredClaims: required,
      })
      if (!result.valid) {
        if (unavailable(result.failures))
          return { status: 'unavailable', reason: reason(result.failures, 'Link is unavailable.') }
        return challenge('invalid', reason(result.failures, 'The Link presentation is invalid.'))
      }
      const disclosed = result.claims
      // A verified email needs both claims, and email_verified must be true.
      const verifiedEmail =
        typeof disclosed.email === 'string' && disclosed.email_verified === true
          ? disclosed.email.toLowerCase()
          : undefined
      if (required.includes('email_verified') && disclosed.email_verified !== true)
        return { status: 'forbidden', reason: 'The email address is not verified.' }
      const value: Types.VerifiedClaims = Object.freeze({
        claims: Object.freeze({ ...disclosed }),
        holderKeyThumbprint: result.holderKeyThumbprint,
        issuer: result.issuer,
        vct: result.vct,
        ...(verifiedEmail && { email: verifiedEmail }),
      })
      if (allow && !(await allow(value, request)))
        return { status: 'forbidden', reason: 'These claims are not allowed.' }
      return { status: 'valid', value }
    },
  }
}

export declare namespace claims {
  type Config = {
    /**
     * Verifies presentations, shared by every request: a `LinkVerifier` from
     * `@stripe/agent-identity`, or {@link presentationVerifier} with options.
     * @default presentationVerifier({ audience, issuer })
     */
    readonly verifier?: Types.ClaimsVerifier | undefined
    /** This server's public origin, such as `https://api.example`: the presentation's audience. */
    readonly audience: string
    /** Claims the presentation must disclose, such as `['email', 'email_verified']`. */
    readonly claims: readonly string[]
    /** Why the server asks, shown to the person whose claims they are. */
    readonly purpose?: string | undefined
    /** Issuer the challenge names: the verifier's. Override only for staging and tests. @default 'https://api.link.com' */
    readonly issuer?: string | undefined
    /** Secret that signs challenge nonces, such as the server's `MPP_SECRET_KEY`. */
    readonly secretKey: string
    /** Seconds a challenge's nonce is accepted for. @default 300 */
    readonly nonceTtl?: number | undefined
    /** Accepts or rejects (`forbidden`, 403) verified claims. Defaults to any. */
    readonly allow?:
      | ((claims: Types.VerifiedClaims, request: Request) => MaybePromise<boolean>)
      | undefined
  }
}

/** The nonce of a presentation's Key Binding JWT, its last `~` segment, unverified. */
function nonceOf(presentation: string): unknown {
  try {
    const kb = presentation.slice(presentation.lastIndexOf('~') + 1)
    const payload = kb.split('.')[1]
    if (!payload) return undefined
    return (JSON.parse(Bytes.toString(Base64.toBytes(payload))) as { nonce?: unknown }).nonce
  } catch {
    return undefined
  }
}

/** Whether an `Authorization` value uses `scheme`. */
function hasScheme(value: string, scheme: string): boolean {
  return value.trimStart().toLowerCase().startsWith(`${scheme.toLowerCase()} `)
}

function unavailable(failures: readonly Types.Failure[]): boolean {
  return failures.some((failure) => failure.code === 'issuer_unavailable')
}

function reason(failures: readonly Types.Failure[], fallback: string): string {
  const first = failures[0]
  return first ? `${first.code}: ${first.message}` : fallback
}
