import type { RouteConfig } from '@x402/core/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'

import * as Facilitator from './server/Facilitator.js'

/** The Tempo x402 facilitator's base URL. */
export const url = 'https://api.tempo.xyz/v1/x402'

/** Base mainnet, the network the Tempo x402 facilitator settles USDC on. */
export const network = 'eip155:8453'
const defaultNetwork: `${string}:${string}` = network

/** Options for {@link tempoX402}. */
export type Options = {
  /** Tempo API key with the `mpp:write` scope. @default process.env.TEMPO_API_KEY */
  apiKey?: string | undefined
  /** x402 network to accept payments on. @default 'eip155:8453' (Base mainnet) */
  network?: `${string}:${string}` | undefined
  /**
   * Tempo address that receives each payment, as `extra.tempoSettlement`. A route can override it.
   * @default process.env.TEMPO_PAYOUT_ADDRESS
   */
  payoutAddress?: string | undefined
  /** How long the facilitator's deposit address (`payTo`) is cached, in milliseconds. @default 300_000 */
  ttl?: number | undefined
  /** Facilitator base URL. @default 'https://api.tempo.xyz/v1/x402' */
  url?: string | undefined
}

/** Options for one route, passed to `route()`. */
export type RouteOptions = Omit<RouteConfig, 'accepts'> & {
  /** Price per request in USD, such as `'$0.01'`. */
  price: string
  /** Tempo address that receives this route's payments, such as a platform's seller. */
  payoutAddress?: string | undefined
}

/**
 * Wires the official x402 SDK to the Tempo x402 facilitator: buyers pay in USDC on Base and the
 * seller is paid out on Tempo.
 *
 * Returns an `x402ResourceServer` with the exact EVM scheme registered and the API key on every
 * facilitator request, and `route()`, which builds a route's config: it sets `payTo` to the
 * facilitator's deposit address (read from `GET /supported`, cached and refreshed every 5
 * minutes) and `extra.tempoSettlement` to the payout address.
 *
 * @example
 * ```ts
 * import { paymentMiddleware } from '@x402/hono'
 * import { tempoX402 } from 'mppx/x402/tempo'
 *
 * const tempo = tempoX402() // reads TEMPO_API_KEY and TEMPO_PAYOUT_ADDRESS
 * app.use(paymentMiddleware({ 'GET /weather': tempo.route({ price: '$0.01' }) }, tempo.server))
 * ```
 */
export function tempoX402(options: Options = {}) {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  const apiKey = options.apiKey || env?.TEMPO_API_KEY
  if (!apiKey) throw new Error('tempoX402 requires `apiKey` or TEMPO_API_KEY.')
  const payoutAddress = options.payoutAddress || env?.TEMPO_PAYOUT_ADDRESS
  const network = options.network ?? defaultNetwork
  const base = options.url ?? url
  const headers = { 'tempo-api-key': apiKey }

  const server = new x402ResourceServer(
    new HTTPFacilitatorClient({
      createAuthHeaders: async () => ({ settle: headers, supported: headers, verify: headers }),
      url: base,
    }),
  ).register(network, new ExactEvmScheme())

  const payTo = Facilitator.payToResolver(base, {
    headers,
    network,
    ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
  })

  /** Builds a paid route's config. Throws when neither the route nor {@link tempoX402} names a payout address. */
  function route(parameters: RouteOptions): RouteConfig {
    const { payoutAddress: routePayoutAddress, price, ...rest } = parameters
    const tempoSettlement = routePayoutAddress ?? payoutAddress
    if (!tempoSettlement)
      throw new Error(
        'tempoX402 requires a payout address: pass `payoutAddress` or set TEMPO_PAYOUT_ADDRESS.',
      )
    return {
      ...rest,
      accepts: {
        extra: { tempoSettlement },
        network,
        payTo: () => payTo(),
        price,
        scheme: 'exact',
      },
    }
  }

  return { payTo, route, server }
}
