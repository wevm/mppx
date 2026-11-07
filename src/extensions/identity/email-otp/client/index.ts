import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from '../../attestation/client/index.js'
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
  if (typeof body.id !== 'string' || typeof body.expires_at !== 'string')
    throw new EmailOtpError('The issuer returned a malformed code request.')
  return { expiresAt: new Date(body.expires_at), id: body.id }
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
  if (typeof body.attestation !== 'string' || typeof body.expires_at !== 'string')
    throw new EmailOtpError('The issuer returned a malformed attestation.')
  return { attestation: body.attestation, expiresAt: new Date(body.expires_at) }
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

/**
 * Creates a prover that verifies an email address when a server asks for one.
 *
 * When a server answers with `Identity-Attestation-Required: email;issuer="…"`,
 * the prover asks the issuer to email a code to `email`, gets the code from
 * `code` (such as a terminal prompt or a form), exchanges it for an
 * attestation bound to the server's origin and sends the request again with it.
 * Later requests to that origin reuse it until it expires.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     EmailOtp.Client.prover({
 *       code: () => prompt('Code:'),
 *       email: 'me@example.com',
 *       issuers: ['https://issuer.example'],
 *       scope: '*',
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
    scope: Identity.Prover['scope']
    /** Email address to verify, or a function that returns it (or `undefined` to decline). */
    email:
      | string
      | ((parameters: { audience: string; issuer: string }) => MaybePromise<string | undefined>)
    /** Returns the code the user received, or `undefined` to give up. */
    code: (parameters: {
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
    attestations?: readonly string[] | undefined
    /**
     * Issuers the prover may send the email address to, such as `['https://identity.mpp.tempo.xyz']`.
     *
     * A server only names the issuer it wants; an untrusted one could relay a code
     * and obtain an attestation for another server.
     */
    issuers: readonly string[]
    /** Fetch used to call the issuer. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
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
  fetch: typeof globalThis.fetch = globalThis.fetch,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${issuer.replace(/\/+$/, '')}${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    // Workers reject 'error'; a redirect is not ok, so it fails below.
    redirect: 'manual',
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok)
    throw new EmailOtpError(
      typeof json.error === 'string' ? json.error : `The issuer answered ${response.status}.`,
      { status: response.status },
    )
  return json
}
