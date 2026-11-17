import { getAddress } from 'viem'

import { FacilitatorResponseError } from '../../Errors.js'
import type * as z from '../../zod.js'
import * as Types from '../Types.js'

const mppxFetchWrapper = Symbol.for('mppx.fetch.wrapper')

type WrappedFetch = typeof globalThis.fetch & {
  [mppxFetchWrapper]?: typeof globalThis.fetch
}

/** Headers to send with each facilitator request, keyed by path. */
export type AuthHeaders = Types.FacilitatorAuthHeaders

export type HttpOptions = {
  /**
   * Returns the headers to send with each facilitator request, keyed by path, such as an API key.
   * Called before every request. Same shape as `createAuthHeaders` in `@x402/core`.
   */
  createAuthHeaders?: Types.FacilitatorConfig['createAuthHeaders']
  /** Fetch implementation used for facilitator RPCs. */
  fetch?: typeof globalThis.fetch | undefined
}

/**
 * Resolves an x402 facilitator URL, `{ url, createAuthHeaders }` config or client into a
 * facilitator client. A config's `createAuthHeaders` takes precedence over `options`.
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
        ...(facilitator.createAuthHeaders
          ? { createAuthHeaders: facilitator.createAuthHeaders }
          : {}),
      })
    return facilitator
  }
  throw new Error(errorMessage)
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
  const authHeaders = async (path: keyof AuthHeaders) =>
    (await options?.createAuthHeaders?.())?.[path]

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
    createAuthHeaders?: HttpOptions['createAuthHeaders']
    fetch?: typeof globalThis.fetch | undefined
    network: string
    scheme?: string | undefined
  },
): Promise<`0x${string}`> {
  const { createAuthHeaders, fetch, network, scheme = 'exact' } = parameters
  const client = resolve(facilitator, 'x402 payTo requires `facilitator`.', {
    createAuthHeaders,
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
