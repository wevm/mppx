import { isAddress } from 'viem'

import * as Currency_ from '../../Currency.js'
import * as defaults from './defaults.js'

/** An accepted Tempo currency: an address or a `viem/tokens` token, chain-indexed or resolved. */
export type Currency = Currency_.Currency

/** Resolves ordered USD offers without expanding acceptance from a live registry. */
export function resolve(parameters: {
  chainId?: number | undefined
  testnet?: boolean | undefined
  /** Accepted currencies. A plain string is a token address (the deprecated `currency` option). */
  currencies?: readonly (Currency | (string & {}))[] | undefined
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
    if (
      typeof token !== 'string' &&
      parameters.decimals !== undefined &&
      parameters.decimals !== token.decimals
    )
      throw new Error('Configured `decimals` must match each token definition.')
    const currency = Currency_.resolve(token as Currency, {
      chainId,
      decimals: parameters.decimals ?? defaults.decimals,
    })
    if (currency === undefined) continue
    if (!isAddress(currency.address, { strict: false }))
      throw new Error(`Invalid Tempo currency address: ${currency.address}.`)
    const decimals = currency.decimals ?? defaults.decimals
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
      throw new Error('Token decimals must be an integer between 0 and 255.')
    const key = currency.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push({ currency: currency.address, decimals, chainId })
  }
  if (resolved.length === 0) throw new Error(`No accepted USD currencies for chain ${chainId}.`)
  return resolved as [(typeof resolved)[number], ...typeof resolved]
}
