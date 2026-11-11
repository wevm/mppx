import { Base64 } from 'ox'

import { unwrapFetch } from '../../../../client/internal/Fetch.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a World ID prover: when a server asks for World ID, it has the server start a World
 * IdP device attempt, passes the approval link to `verification` (show it to the person behind
 * the agent), and polls until they approve in World App. Then it sends the request again with
 * the session the server issued, and every later request to that origin carries it until it
 * expires.
 *
 * The device code and ID token stay on the server: the prover only sees the approval link, an
 * opaque attempt token and the session.
 *
 * @example
 * ```ts
 * Mppx.create({
 *   identity: [
 *     World.Client.prover({
 *       scope: ['https://api.example'],
 *       verification: ({ url, userCode }) => console.log(`Approve at ${url} (${userCode})`),
 *     }),
 *   ],
 *   methods,
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const sessions = new Map<string, { token: string; expiresAt: number }>()
  return {
    scope: config.scope,
    headers: [Constants.header, Constants.pollHeader],
    prove(request) {
      const origin = new URL(request.url).origin
      const session = sessions.get(origin)
      if (!session || session.expiresAt <= Date.now()) return request
      const headers = new Headers(request.headers)
      headers.set(Constants.header, session.token)
      return new Request(request, { headers })
    },
    async retry(response, { request }) {
      if (response.status !== 401 || !response.headers.has(Constants.requiredHeader))
        return undefined
      const origin = new URL(request.url).origin
      sessions.delete(origin)
      const session = await authenticate(request, config)
      if (!session) return undefined
      sessions.set(origin, session)
      return {}
    },
  }
}

export declare namespace prover {
  type Config = {
    /** Origins that may ask for World ID and receive the session, or `'*'` for any origin. */
    scope: Identity.Prover['scope']
    /**
     * Shows the person the approval link, such as in a terminal or a chat message. Return
     * `false` to stop without waiting for approval.
     */
    verification: (parameters: {
      /** Origin asking for World ID. */
      origin: string
      /** Approval page, with the code filled in when World IdP provides one. */
      url: string
      /** Code the person confirms on the approval page. */
      userCode: string
      /** When the attempt expires. */
      expiresAt: Date
    }) => MaybePromise<boolean | void>
    /** Fetch used for the device-flow calls to the server. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
  }
}

/**
 * Runs a device attempt through the server that asked: starts it, shows the link and polls at
 * the server's interval until it is approved, declined or expired.
 */
async function authenticate(
  request: Request,
  config: prover.Config,
): Promise<{ token: string; expiresAt: number } | undefined> {
  // Unwrapped, so a device-flow call is never paid; it never reaches the route's handler.
  const fetch = unwrapFetch(config.fetch ?? globalThis.fetch)
  const call = async (poll: string) => {
    const response = await fetch(
      new Request(request.url, {
        method: request.method,
        headers: { [Constants.pollHeader]: poll },
        redirect: 'manual',
      }),
    )
    void response.body?.cancel().catch(() => {})
    return parse(response.headers.get(Constants.deviceHeader))
  }

  let device = await call('start')
  if (device?.status !== 'pending') return undefined
  const origin = new URL(request.url).origin
  const expiresAt = Date.now() + device.expires_in * 1_000
  const shown = await config.verification({
    origin,
    url: device.verification_uri_complete ?? device.verification_uri,
    userCode: device.user_code,
    expiresAt: new Date(expiresAt),
  })
  if (shown === false) return undefined

  while (device.status === 'pending') {
    const wait = device.interval * 1_000
    if (Date.now() + wait >= expiresAt) return undefined
    await new Promise((resolve) => setTimeout(resolve, wait))
    // A lost connection to the server backs off and polls again; any answer is followed.
    const next: Types.Device | undefined = await call(device.attempt).catch(() => device)
    if (!next) return undefined
    device = next
  }
  if (device.status !== 'approved') return undefined
  return { token: device.session, expiresAt: Date.now() + device.expires_in * 1_000 }
}

/** Parses a `World-Id-Device` header, or returns `undefined` when it is missing or malformed. */
function parse(value: string | null): Types.Device | undefined {
  if (!value) return undefined
  try {
    const device = JSON.parse(Base64.toString(value)) as Types.Device
    if (device.status === 'pending') {
      const { attempt, expires_in, interval, user_code, verification_uri } = device
      const complete = device.verification_uri_complete
      if (
        typeof attempt !== 'string' ||
        typeof user_code !== 'string' ||
        !isHttps(verification_uri) ||
        (complete !== undefined && !isHttps(complete)) ||
        !isSeconds(expires_in) ||
        !isSeconds(interval)
      )
        return undefined
      return device
    }
    if (device.status === 'approved')
      return typeof device.session === 'string' && isSeconds(device.expires_in) ? device : undefined
    if (device.status === 'denied' || device.status === 'expired') return device
  } catch {}
  return undefined
}

/** Only https approval links are shown, so a server can't send the person elsewhere by scheme. */
function isHttps(value: unknown): value is string {
  return typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:'
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 86_400
}
