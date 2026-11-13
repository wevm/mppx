import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from '../../attestation/client/index.js'
import { isIssuer } from '../../attestation/Token.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/** Asks a World ID issuer to start a device attempt for `audience`. */
export async function startDevice(parameters: startDevice.Parameters): Promise<Types.Device> {
  const { body, response } = await post(parameters.issuer, Constants.devicePath, parameters.fetch, {
    audience: parameters.audience,
  })
  if (!response.ok)
    throw new WorldIdError(errorOf(body) ?? `The issuer answered ${response.status}.`, {
      status: response.status,
    })
  const { expires_in, id, interval, user_code, verification_uri, verification_uri_complete } = body
  if (
    !isText(id) ||
    !isText(user_code) ||
    !isHttps(verification_uri) ||
    (verification_uri_complete !== undefined && !isHttps(verification_uri_complete)) ||
    !isSeconds(expires_in) ||
    (interval !== undefined && !(isSeconds(interval) || interval === 0))
  )
    throw new WorldIdError('The issuer returned a malformed device attempt.')
  return Object.freeze({
    expiresAt: new Date(Date.now() + expires_in * 1_000),
    id,
    interval: (interval as number | undefined) ?? Constants.interval,
    userCode: user_code,
    verificationUri: verification_uri,
    ...(verification_uri_complete !== undefined && {
      verificationUriComplete: verification_uri_complete as string,
    }),
  })
}

export declare namespace startDevice {
  type Parameters = {
    /** Issuer URL. */
    issuer: string
    /** Origin of the server the attestation is for. */
    audience: string
    /** Fetch implementation. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
}

/**
 * Polls a device attempt once. Throws a `WorldIdError` when the attempt ended without approval
 * (`access_denied`, `expired_token` or another error); a 429, 5xx, timeout or network error is
 * `unavailable`, never an approval or a failure.
 */
export async function pollDevice(parameters: pollDevice.Parameters): Promise<Types.Poll> {
  let result: Awaited<ReturnType<typeof post>>
  try {
    result = await post(parameters.issuer, Constants.tokenPath, parameters.fetch, {
      id: parameters.id,
    })
  } catch (error) {
    if (error instanceof WorldIdError) throw error
    return { status: 'unavailable' }
  }
  const { body, response } = result
  if (response.status === 429 || response.status >= 500) return { status: 'unavailable' }
  if (response.ok) {
    const expiresAt = isText(body.expires_at) ? new Date(body.expires_at) : undefined
    if (!isText(body.attestation) || !expiresAt || !Number.isFinite(expiresAt.getTime()))
      throw new WorldIdError('The issuer returned a malformed attestation.')
    return { status: 'approved', attestation: body.attestation, expiresAt }
  }
  const error = errorOf(body)
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') return { status: 'slow_down' }
  throw new WorldIdError(
    error === 'access_denied'
      ? 'World ID was not approved.'
      : error === 'expired_token'
        ? 'The World ID attempt expired.'
        : (error ?? `The issuer answered ${response.status}.`),
    { code: error, status: response.status },
  )
}

export declare namespace pollDevice {
  type Parameters = {
    /** Issuer URL. */
    issuer: string
    /** Attempt identifier from {@link startDevice}. */
    id: string
    /** Fetch implementation. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
}

/**
 * Creates a prover that gets a human's World ID approval when a server asks for one: an
 * `Attestation.Client.prover` of type `world-id` whose `acquire` runs the issuer's device flow.
 *
 * When a server answers with `Identity-Attestation-Required: world-id;issuer="…"`, the prover
 * asks the issuer to start a device attempt for the server's origin, shows the human the approval
 * link through `verification`, and polls the issuer at its interval until the human approves in
 * World App. It then sends the request again with the attestation, and reuses it for that origin
 * until it expires.
 *
 * - Concurrent requests to one origin share one attempt, so the human sees one link.
 * - After an attempt fails or is declined, requests to that origin get the failure for
 *   `Constants.retryDelay` seconds instead of starting another attempt.
 * - An unavailable issuer (429, 5xx, timeout) is polled again at the interval until the attempt
 *   expires.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     World.Client.prover({
 *       issuers: ['https://world-id.issuer.example'],
 *       scope: ['https://api.example'],
 *       verification: ({ url, userCode }) => console.log(`Approve: ${url} (code ${userCode})`),
 *     }),
 *   ],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  // Failed or declined attempts by issuer and audience, so a failure is not retried in a loop.
  const failures = new Map<string, { until: number; error?: unknown }>()
  return Attestation.prover({
    attestations: config.attestations,
    issuers: config.issuers,
    scope: config.scope,
    types: [Constants.type],
    async acquire({ audience, issuer }) {
      const key = JSON.stringify([issuer, audience])
      const failure = failures.get(key)
      if (failure && failure.until > Date.now()) {
        if (failure.error) throw failure.error
        return undefined
      }
      failures.delete(key)
      try {
        const token = await authenticate({ audience, issuer })
        if (!token) failures.set(key, { until: Date.now() + Constants.retryDelay * 1_000 })
        return token
      } catch (error) {
        failures.set(key, { error, until: Date.now() + Constants.retryDelay * 1_000 })
        throw error
      }
    },
  })

  async function authenticate({ audience, issuer }: { audience: string; issuer: string }) {
    const device = await startDevice({ audience, fetch: config.fetch, issuer })
    const shown = await config.verification({
      expiresAt: device.expiresAt,
      issuer,
      origin: audience,
      url: device.verificationUriComplete ?? device.verificationUri,
      userCode: device.userCode,
    })
    if (shown === false) return undefined
    let interval = device.interval
    while (true) {
      // The first poll waits an interval too (RFC 8628).
      if (Date.now() + interval * 1_000 >= device.expiresAt.getTime())
        throw new WorldIdError('The World ID attempt expired.', { code: 'expired_token' })
      await sleep(interval * 1_000)
      const result = await pollDevice({ fetch: config.fetch, id: device.id, issuer })
      if (result.status === 'approved') return result.attestation
      if (result.status === 'slow_down') interval += Constants.slowDown
    }
  }
}

export declare namespace prover {
  type Config = {
    /** Origins that may ask for and receive the attestation, or `'*'` for any origin. */
    readonly scope: Identity.Prover['scope']
    /** World ID issuers the prover may use, such as `['https://world-id.issuer.example']`. */
    readonly issuers: readonly string[]
    /**
     * Shows the human the approval link, such as in a terminal or a chat message. Return `false`
     * to decline without waiting for approval.
     */
    readonly verification: (parameters: {
      /** Origin asking for World ID. */
      origin: string
      /** Issuer running the attempt. */
      issuer: string
      /** Approval page, with the code filled in when the issuer provides one. */
      url: string
      /** Code the human confirms on the approval page. */
      userCode: string
      /** When the attempt expires. */
      expiresAt: Date
    }) => MaybePromise<boolean | void>
    /** Attestations obtained beforehand. */
    readonly attestations?: readonly string[] | undefined
    /** Fetch used to call the issuer. @default globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch | undefined
  }
}

/** A World ID issuer refused a request, or an attempt ended without approval. */
export class WorldIdError extends Error {
  override readonly name = 'WorldIdError'
  /** OAuth error code the issuer answered with, such as `access_denied`, if any. */
  readonly code: string | undefined
  /** HTTP status the issuer answered with, if any. */
  readonly status: number | undefined
  constructor(
    message: string,
    options: { code?: string | undefined; status?: number | undefined } = {},
  ) {
    super(message)
    this.code = options.code
    this.status = options.status
  }
}

async function post(
  issuer: string,
  path: string,
  fetch: typeof globalThis.fetch | undefined,
  body: Record<string, string>,
): Promise<{ body: Record<string, unknown>; response: Response }> {
  // Attempt IDs and attestations never go over plaintext HTTP, except to localhost.
  if (!isIssuer(issuer))
    throw new WorldIdError('The issuer must be an https URL (http only on localhost).')
  // The unwrapped fetch, so an issuer's 402 is never paid automatically.
  const response = await unwrapFetch(fetch ?? globalThis.fetch)(
    `${issuer.replace(/\/+$/, '')}${path}`,
    {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      // Workers reject 'error'; a redirect is not ok, so it fails as a refusal.
      redirect: 'manual',
      signal: AbortSignal.timeout(Constants.requestTimeout),
    },
  )
  // A body that fails to arrive (reset, timeout) throws, so a poll counts it as unavailable;
  // only a body that arrived but isn't a JSON object reads as empty.
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {}
  return {
    body: json && typeof json === 'object' ? (json as Record<string, unknown>) : {},
    response,
  }
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return isText(body.error) ? body.error : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isHttps(value: unknown): value is string {
  return isText(value) && URL.canParse(value) && new URL(value).protocol === 'https:'
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
