import { getAddress } from 'viem'

import * as Types from '../Types.js'

const mppxFetchWrapper = Symbol.for('mppx.fetch.wrapper')

type WrappedFetch = typeof globalThis.fetch & {
  [mppxFetchWrapper]?: typeof globalThis.fetch
}

export type HttpOptions = {
  /** Fetch implementation used for facilitator RPCs. */
  fetch?: typeof globalThis.fetch | undefined
}

/** Resolves an x402 facilitator URL or client into a facilitator client. */
export function resolve(
  facilitator: string | Types.Facilitator,
  errorMessage = 'x402 exact requires `facilitator`.',
  options?: HttpOptions | undefined,
): Types.Facilitator {
  if (typeof facilitator === 'object' && facilitator !== null) return facilitator
  if (typeof facilitator === 'string') return http(facilitator, options)
  throw new Error(errorMessage)
}

/** Creates an x402 facilitator client from an HTTP base URL. */
export function http(url: string, options?: HttpOptions | undefined): Types.Facilitator {
  const base = url.replace(/\/$/, '')
  const fetch = unwrapFetch(options?.fetch ?? globalThis.fetch)
  return {
    async verify(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/verify`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements, x402Version: 2 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return Types.VerifyResponseSchema.parse(await response.json())
    },
    async settle(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/settle`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements, x402Version: 2 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return Types.SettleResponseSchema.parse(await response.json())
    },
    async supported() {
      const response = await fetch(`${base}/supported`, { method: 'GET' })
      if (!response.ok) throw new Error(`x402 facilitator /supported failed: ${response.status}`)
      return Types.SupportedResponseSchema.parse(await response.json())
    },
  }
}

/**
 * Reads the `payTo` a facilitator publishes for a scheme and network in `GET /supported`
 * (`kinds[].extra.payTo`), for facilitators that settle into an address of their own, the way
 * Solana facilitators publish `extra.feePayer`. Call it once at startup and pass the result as
 * `recipient`.
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
  facilitator: string | Types.Facilitator,
  parameters: {
    fetch?: typeof globalThis.fetch | undefined
    network: string
    scheme?: string | undefined
  },
): Promise<`0x${string}`> {
  const { network, scheme = 'exact' } = parameters
  const client =
    typeof facilitator === 'string' ? http(facilitator, { fetch: parameters.fetch }) : facilitator
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
