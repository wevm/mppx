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
