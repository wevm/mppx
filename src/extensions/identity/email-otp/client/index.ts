import { unwrapFetch, withoutPayment } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from '../../attestation/client/index.js'
import { isIssuer } from '../../attestation/Token.js'
import { Constants } from '../Constants.js'

/**
 * Asks an issuer to email a one-time code for `audience`.
 *
 * Returns the code request's `id`, which {@link verifyCode} exchanges, with the code, for an attestation.
 */
export async function sendCode(parameters: sendCode.Parameters): Promise<sendCode.ReturnType> {
  const body = await post(parameters.issuer, Constants.otpPath, parameters.fetch, {
    audience: parameters.audience,
    email: parameters.email,
  })
  const expiresAt = date(body.expires_at)
  if (typeof body.id !== 'string' || body.id === '' || !expiresAt)
    throw new EmailOtpError('The issuer returned a malformed code request.')
  return { expiresAt, id: body.id }
}

export declare namespace sendCode {
  type Parameters = {
    /** Issuer URL. */
    issuer: string
    /** Email address to send the code to. */
    email: string
    /** Origin of the server the attestation is for. */
    audience: string
    /** Fetch implementation. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
  type ReturnType = { id: string; expiresAt: Date }
}

/** Exchanges an emailed one-time code for an email attestation. */
export async function verifyCode(
  parameters: verifyCode.Parameters,
): Promise<verifyCode.ReturnType> {
  const body = await post(parameters.issuer, Constants.verifyPath, parameters.fetch, {
    code: parameters.code,
    id: parameters.id,
  })
  const expiresAt = date(body.expires_at)
  if (typeof body.attestation !== 'string' || body.attestation === '' || !expiresAt)
    throw new EmailOtpError('The issuer returned a malformed attestation.')
  return { attestation: body.attestation, expiresAt }
}

export declare namespace verifyCode {
  type Parameters = {
    /** Issuer URL. */
    issuer: string
    /** Code request ID from {@link sendCode}. */
    id: string
    /** The code from the email. */
    code: string
    /** Fetch implementation. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
  type ReturnType = { attestation: string; expiresAt: Date }
}

/** Parses an issuer timestamp, or returns `undefined` when it is not a valid date. */
function date(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const result = new Date(value)
  return Number.isFinite(result.getTime()) ? result : undefined
}

/**
 * Creates a prover that verifies an email address when a server asks for one: an
 * `Attestation.Client.prover` of type `email` whose `acquire` sends the code, prompts and verifies.
 *
 * When a server answers with `Identity-Attestation-Required: email;issuer="…"`,
 * the prover asks the issuer to email a code to `email`, gets the code from
 * `code` (such as a terminal prompt or a form), exchanges it for an
 * attestation bound to the server's origin and sends the request again with it.
 * Later requests to that origin reuse it until it expires. A route that accepts any of several
 * issuers (`Identity.anyOf`) lists them as alternatives: the prover asks the first trusted one,
 * and the next only if that one fails or is declined. A route that requires several issuers gets
 * a code from, and a prompt for, each of them.
 *
 * Trust is set by two options together:
 * - `scope`: the origins that may ask for and receive the attestation. It is always
 *   bound to the request's own origin, never one a server names.
 * - `issuers`: the issuers the email address may be sent to. A server only names the
 *   issuer it wants; an untrusted one could relay a code and obtain an attestation
 *   for another server.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     EmailOtp.Client.prover({
 *       code: () => prompt('Code:'),
 *       email: 'me@example.com',
 *       // Only this issuer receives the address, and only this origin the attestation.
 *       issuers: ['https://issuer.example'],
 *       scope: ['https://api.example'],
 *     }),
 *   ],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  return Attestation.prover({
    attestations: config.attestations,
    issuers: config.issuers,
    scope: config.scope,
    types: [Constants.type],
    async acquire({ audience, issuer }) {
      const email =
        typeof config.email === 'function' ? await config.email({ audience, issuer }) : config.email
      if (!email) return undefined
      const request = await sendCode({ audience, email, fetch: config.fetch, issuer })
      let error: Error | undefined
      for (let attempt = 1; attempt <= Constants.codeAttempts; attempt++) {
        const code = await config.code({ ...request, attempt, audience, email, error, issuer })
        if (!code) return undefined
        try {
          return (
            await verifyCode({ code: code.trim(), fetch: config.fetch, id: request.id, issuer })
          ).attestation
        } catch (caught) {
          // Only a rejected code is worth another try; other failures end the attempt.
          if (!(caught instanceof EmailOtpError) || caught.status !== 400) throw caught
          error = caught
        }
      }
      throw error
    },
  })
}

export declare namespace prover {
  type Config = {
    /** Origins that may ask for and receive the attestation, or `'*'` for any origin. */
    readonly scope: Identity.Prover['scope']
    /** Email address to verify, or a function that returns it (or `undefined` to decline). */
    readonly email:
      | string
      | ((parameters: { audience: string; issuer: string }) => MaybePromise<string | undefined>)
    /** Returns the code the user received, or `undefined` to give up. */
    readonly code: (parameters: {
      /** Origin the attestation is for. */
      audience: string
      /** Email address the code was sent to. */
      email: string
      /** Issuer URL. */
      issuer: string
      /** Code request ID. */
      id: string
      /** When the code expires. */
      expiresAt: Date
      /** 1 for the first prompt, higher after a rejected code. */
      attempt: number
      /** Why the previous code was rejected. */
      error?: Error | undefined
    }) => MaybePromise<string | undefined>
    /** Attestations obtained beforehand, such as from the issuer with curl. */
    readonly attestations?: readonly string[] | undefined
    /** Issuers the prover may send the email address to, such as `['https://identity.mpp.tempo.xyz']`. */
    readonly issuers: readonly string[]
    /** Fetch used to call the issuer. @default globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch | undefined
  }
}

/** An issuer rejected an email OTP request. */
export class EmailOtpError extends Error {
  override readonly name = 'EmailOtpError'
  /** HTTP status the issuer answered with, if any. */
  readonly status: number | undefined
  constructor(message: string, options: { status?: number | undefined } = {}) {
    super(message)
    this.status = options.status
  }
}

async function post(
  issuer: string,
  path: string,
  fetch: typeof globalThis.fetch | undefined,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  // The address and code never go over plaintext HTTP, except to localhost.
  if (!isIssuer(issuer))
    throw new EmailOtpError('The issuer must be an https URL (http only on localhost).')
  // Untagged forwarding wrappers survive unwrapping, so also opt out explicitly.
  const response = await unwrapFetch(fetch ?? globalThis.fetch)(
    `${issuer.replace(/\/+$/, '')}${path}`,
    withoutPayment({
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      // Workers reject 'error'; a redirect is not ok, so it fails below.
      redirect: 'manual',
    }),
  )
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok)
    throw new EmailOtpError(
      typeof json.error === 'string' ? json.error : `The issuer answered ${response.status}.`,
      { status: response.status },
    )
  return json
}
