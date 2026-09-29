import { isAddress } from 'viem'
import type { Token } from 'viem/tokens'

import * as defaults from './defaults.js'

/** An explicit token address or a chain-indexed token definition. */
export type Currency = string | Token

/** Resolves ordered USD offers without expanding acceptance from a live registry. */
export function resolve(parameters: {
  chainId?: number | undefined
  testnet?: boolean | undefined
  currencies?: readonly Currency[] | undefined
  decimals?: number | undefined
}) {
  const chainId =
    parameters.chainId ?? (parameters.testnet ? defaults.chainId.testnet : defaults.chainId.mainnet)
  const currencies =
    parameters.currencies ??
    (chainId === defaults.chainId.mainnet
      ? [defaults.tokens.ousd, defaults.tokens.usdc]
      : chainId === defaults.chainId.testnet
        ? [defaults.tokens.ousd, defaults.tokens.pathUsd]
        : [defaults.resolveCurrency({ chainId })])

  const seen = new Set<string>()
  const resolved: { currency: string; decimals: number; chainId: number }[] = []
  for (const token of currencies) {
    // A shared USD price cannot also price EUR, BTC, or unknown denominations.
    if (typeof token !== 'string' && token.currency !== 'USD') continue
    const currency = typeof token === 'string' ? token : token.addresses[chainId]
    if (currency === undefined) continue
    if (!isAddress(currency, { strict: false }))
      throw new Error(`Invalid Tempo currency address: ${currency}.`)
    const decimals =
      typeof token === 'string' ? (parameters.decimals ?? defaults.decimals) : token.decimals
    if (
      typeof token !== 'string' &&
      parameters.decimals !== undefined &&
      parameters.decimals !== decimals
    )
      throw new Error('Configured `decimals` must match each token definition.')
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
      throw new Error('Token decimals must be an integer between 0 and 255.')
    const key = currency.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push({ currency, decimals, chainId })
  }
  if (resolved.length === 0) throw new Error(`No accepted USD currencies for chain ${chainId}.`)
  return resolved as [(typeof resolved)[number], ...typeof resolved]
}
