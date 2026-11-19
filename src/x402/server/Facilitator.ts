import { getAddress } from 'viem'

import { FacilitatorResponseError } from '../../Errors.js'
import type * as z from '../../zod.js'
import * as Types from '../Types.js'

const mppxFetchWrapper = Symbol.for('mppx.fetch.wrapper')

type WrappedFetch = typeof globalThis.fetch & {
  [mppxFetchWrapper]?: typeof globalThis.fetch
}

/** Headers to send with facilitator requests: a flat record, or one keyed by path. */
export type FacilitatorHeaders = Types.FacilitatorHeaders

export type HttpOptions = {
  /**
   * Headers to send with facilitator requests, such as an API key: a flat record for every
   * request, or an object keyed by `verify`, `settle` and `supported`. A function is called before
   * every request.
   */
  headers?: Types.FacilitatorConfig['headers']
  /** Fetch implementation used for facilitator RPCs. */
  fetch?: typeof globalThis.fetch | undefined
}

/**
 * Resolves an x402 facilitator URL, `{ url, headers }` config or client into a
 * facilitator client. A config's `headers` take precedence over `options`.
 */
export function resolve(
  facilitator: string | Types.FacilitatorConfig | Types.Facilitator,
  errorMessage = 'x402 exact requires `facilitator`.',
  options?: HttpOptions | undefined,
): Types.Facilitator {
  if (typeof facilitator === 'string') return http(facilitator, options)
  if (typeof facilitator === 'object' && facilitator !== null) {
    if (isConfig(facilitator))
      return http(facilitator.url, {
        ...options,
        ...(facilitator.headers ? { headers: facilitator.headers } : {}),
      })
    return facilitator
  }
  throw new Error(errorMessage)
}

const paths = ['settle', 'supported', 'verify']

/**
 * Picks the headers for one facilitator path. `headers` is per-path only when it has at least one
 * key, every key is `verify`, `settle` or `supported` and every value is an object; otherwise it
 * is a flat record sent on every path.
 */
function pathHeaders(
  headers: Types.FacilitatorHeaders | undefined,
  path: 'settle' | 'supported' | 'verify',
): Record<string, string> | undefined {
  if (!headers) return undefined
  const entries = Object.entries(headers)
  const perPath =
    entries.length > 0 &&
    entries.every(
      ([key, value]) => paths.includes(key) && typeof value === 'object' && value !== null,
    )
  return perPath
    ? (headers as Types.FacilitatorPathHeaders)[path]
    : (headers as Record<string, string>)
}

/**
 * Creates an x402 facilitator client from an HTTP base URL.
 *
 * A non-2xx response throws `Errors.FacilitatorResponseError`, except a `/verify` or `/settle`
 * error whose body is a failed result (`isValid: false` or `success: false`), which is returned
 * as that result, the way `@x402/core` reads it.
 */
export function http(url: string, options?: HttpOptions | undefined): Types.Facilitator {
  const base = url.replace(/\/$/, '')
  const fetch = unwrapFetch(options?.fetch ?? globalThis.fetch)
  const authHeaders = async (path: 'settle' | 'supported' | 'verify') => {
    const headers = options?.headers
    return pathHeaders(typeof headers === 'function' ? await headers() : headers, path)
  }

  async function post(path: 'settle' | 'verify', body: unknown) {
    return fetch(`${base}/${path}`, {
      body: JSON.stringify(body),
      headers: { ...(await authHeaders(path)), 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  return {
    async verify(paymentPayload, paymentRequirements) {
      const response = await post('verify', { paymentPayload, paymentRequirements, x402Version: 2 })
      const body = await readBody(response)
      if (!response.ok) {
        const failed = Types.VerifyResponseSchema.safeParse(body.json)
        if (failed.success && failed.data.isValid === false) return failed.data
        throw responseError('verify', response, body.text)
      }
      return parseResult('verify', Types.VerifyResponseSchema, response, body)
    },
    async settle(paymentPayload, paymentRequirements) {
      const response = await post('settle', { paymentPayload, paymentRequirements, x402Version: 2 })
      const body = await readBody(response)
      if (!response.ok) {
        const failed = Types.SettleResponseSchema.safeParse(body.json)
        if (failed.success && failed.data.success === false) return failed.data
        throw responseError('settle', response, body.text)
      }
      return parseResult('settle', Types.SettleResponseSchema, response, body)
    },
    async supported() {
      const headers = await authHeaders('supported')
      const response = await fetch(
        `${base}/supported`,
        headers ? { headers, method: 'GET' } : { method: 'GET' },
      )
      const body = await readBody(response)
      if (!response.ok) throw responseError('supported', response, body.text)
      return parseResult('supported', Types.SupportedResponseSchema, response, body)
    },
  }
}

/**
 * Reads the `payTo` a facilitator publishes for a scheme and network in `GET /supported`
 * (`kinds[].extra.payTo`), for facilitators that settle into an address of their own, the way
 * Solana facilitators publish `extra.feePayer`. Call it once at startup and pass the result as
 * `recipient`. Accepts the same facilitator forms as `x402.facilitator`.
 *
 * @example
 * ```ts
 * evm({
 *   currency: evm.assets.base.USDC,
 *   recipient: await x402.Facilitator.payTo(FACILITATOR_URL, { network: 'eip155:8453' }),
 *   x402: { facilitator: FACILITATOR_URL, extra: { tempoSettlement: '0x…' } },
 * })
 * ```
 */
export async function payTo(
  facilitator: string | Types.FacilitatorConfig | Types.Facilitator,
  parameters: {
    /** Headers to send with `GET /supported` when `facilitator` is a URL. */
    headers?: HttpOptions['headers']
    fetch?: typeof globalThis.fetch | undefined
    network: string
    scheme?: string | undefined
  },
): Promise<`0x${string}`> {
  const { headers, fetch, network, scheme = 'exact' } = parameters
  const client = resolve(facilitator, 'x402 payTo requires `facilitator`.', {
    headers,
    fetch,
  })
  if (!client.supported)
    throw new Error(
      'x402 facilitator does not implement `supported()`, so it cannot provide payTo.',
    )
  const { kinds } = await client.supported()
  const kind = kinds.find(
    (kind) => kind.x402Version === 2 && kind.scheme === scheme && kind.network === network,
  )
  const value = kind?.extra?.payTo
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error(`x402 facilitator publishes no payTo for ${scheme} on ${network}.`)
  return getAddress(value)
}

/**
 * A function that returns the current recipient, reading it on demand and caching it, and that
 * remembers the addresses it replaced for a grace period (see {@link createPayToResolver}).
 */
export type PayToResolver = (() => Promise<`0x${string}`>) & {
  /** The last address read, without reading; `undefined` before the first success. */
  readonly current: `0x${string}` | undefined
  /**
   * The current address, or one it replaced less than `grace` ago, equal to `address`
   * (case-insensitive); otherwise `undefined`. A server accepts a payment naming an older address
   * only through this, so a caller can never pick an address the server didn't issue.
   */
  issued(address: string): `0x${string}` | undefined
}

/** Options for {@link createPayToResolver} and {@link payToResolver}. */
export type PayToResolverOptions = {
  /**
   * How long a replaced address still verifies, in milliseconds. Also how long past `ttl` the
   * last address keeps being served while reads fail. @default 600_000 (10 minutes)
   */
  grace?: number | undefined
  /** How long one read may take before it is aborted, in milliseconds. @default 10_000 */
  timeout?: number | undefined
  /** How long a read stays fresh, in milliseconds. @default 300_000 (5 minutes) */
  ttl?: number | undefined
}

/**
 * Wraps `read` in a {@link PayToResolver}. Concurrent calls share one read. A read that takes
 * longer than `timeout` is aborted through the signal it receives, and fails. Before the first
 * success a failure is shared with every caller for 30 seconds (each gets its own error); after
 * it, a failed refresh keeps the last address and retries after 30 seconds, until the last
 * successful read is older than `ttl + grace`, when reads fail again.
 */
export function createPayToResolver(
  read: (options: { signal: AbortSignal }) => Promise<string>,
  options: PayToResolverOptions = {},
): PayToResolver {
  const { grace = 600_000, timeout = 10_000, ttl = 300_000 } = options
  const retryAfterFailure = Math.min(ttl, 30_000)
  let current: `0x${string}` | undefined
  let freshUntil = 0
  let readAt = 0
  let failure: { error: unknown; until: number } | undefined
  let retired: { address: `0x${string}`; at: number }[] = []
  let pending: Promise<`0x${string}`> | undefined

  function readWithTimeout(): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`Reading the recipient timed out after ${timeout}ms.`)),
      timeout,
    )
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      })
    })
    return Promise.race([
      Promise.resolve().then(() => read({ signal: controller.signal })),
      aborted,
    ]).finally(() => clearTimeout(timer))
  }

  function replace(address: `0x${string}`, now: number) {
    retired = retired.filter(
      (entry) => entry.address.toLowerCase() !== address.toLowerCase() && now - entry.at < grace,
    )
    if (current && current.toLowerCase() !== address.toLowerCase())
      retired.push({ address: current, at: now })
    current = address
  }

  function unavailable(cause: unknown): Error {
    // A fresh error per caller: rethrowing one instance would mix every caller's stack into it.
    const error = new Error(`Recipient unavailable: ${(cause as Error)?.message ?? String(cause)}`)
    // Set by hand (non-enumerable, like native `cause`) for consumers on pre-ES2022 libs.
    Object.defineProperty(error, 'cause', { configurable: true, value: cause, writable: true })
    return error
  }

  const resolve = (async () => {
    if (current && Date.now() < freshUntil) return current
    if (failure && Date.now() < failure.until) throw unavailable(failure.error)
    pending ??= readWithTimeout()
      .then((value) => {
        const address = getAddress(value)
        // Measured after the read, so a slow read doesn't shorten the windows.
        const now = Date.now()
        failure = undefined
        readAt = now
        replace(address, now)
        freshUntil = now + ttl
        return address
      })
      .catch((error) => {
        const now = Date.now()
        if (!current || now - readAt > ttl + grace) {
          failure = { error, until: now + retryAfterFailure }
          throw error
        }
        freshUntil = now + retryAfterFailure
        return current
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }) as PayToResolver

  Object.defineProperty(resolve, 'current', { get: () => current })
  ;(resolve as { issued: PayToResolver['issued'] }).issued = (address) => {
    const wanted = address.toLowerCase()
    if (current && current.toLowerCase() === wanted) return current
    const now = Date.now()
    for (let i = retired.length - 1; i >= 0; i--) {
      const entry = retired[i]!
      if (entry.address.toLowerCase() === wanted && now - entry.at < grace) return entry.address
    }
    return undefined
  }
  return resolve
}

/**
 * Returns a {@link PayToResolver} for a facilitator's published `payTo` (see {@link payTo}), so a
 * facilitator that rotates its deposit address is picked up without a restart. Payments naming an
 * address it replaced still verify for `grace`.
 *
 * For a facilitator URL, reads are aborted on `timeout` and refuse redirects, so headers such as
 * an API key are never forwarded to another origin. A {@link Types.Facilitator} object is called
 * as is and can't be aborted.
 *
 * @example
 * ```ts
 * const payTo = x402.Facilitator.payToResolver(FACILITATOR_URL, { network: 'eip155:8453' })
 * await payTo() // fetched on first use, then cached
 * ```
 */
export function payToResolver(
  facilitator: string | Types.FacilitatorConfig | Types.Facilitator,
  parameters: Parameters<typeof payTo>[1] & PayToResolverOptions,
): PayToResolver {
  const { grace, timeout, ttl, fetch: fetch_, ...options } = parameters
  return createPayToResolver(
    ({ signal }) =>
      payTo(facilitator, {
        ...options,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          unwrapFetch(fetch_ ?? globalThis.fetch)(input, {
            ...init,
            redirect: 'error',
            signal,
          })) as typeof globalThis.fetch,
      }),
    { grace, timeout, ttl },
  )
}

/** Returns the underlying raw fetch implementation when given an mppx wrapper. */
export function unwrapFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  let current = fetch as WrappedFetch
  while (current[mppxFetchWrapper]) {
    current = current[mppxFetchWrapper] as WrappedFetch
  }
  return current as typeof globalThis.fetch
}

function isConfig(
  facilitator: Types.FacilitatorConfig | Types.Facilitator,
): facilitator is Types.FacilitatorConfig {
  return (
    typeof (facilitator as Types.FacilitatorConfig).url === 'string' &&
    typeof (facilitator as Types.Facilitator).verify !== 'function'
  )
}

async function readBody(response: Response) {
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {}
  return { json, text }
}

function parseResult<schema extends z.ZodMiniType>(
  path: FacilitatorResponseError['path'],
  schema: schema,
  response: Response,
  body: { json: unknown; text: string },
): z.infer<schema> {
  const parsed = schema.safeParse(body.json)
  if (!parsed.success) throw responseError(path, response, body.text, parsed.error)
  return parsed.data
}

function responseError(
  path: FacilitatorResponseError['path'],
  response: Response,
  body: string,
  cause?: unknown,
) {
  return new FacilitatorResponseError({ body, cause, path, status: response.status })
}
