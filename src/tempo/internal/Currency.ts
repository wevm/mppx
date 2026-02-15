import type { Address } from 'viem'

export const usd: Record<number, readonly Address[]> = {
  4217: ['0x20c0000000000000000000000000000000000000'],
  42431: ['0x20c0000000000000000000000000000000000000'],
} as const

export const dexRouter: Record<number, Address> = {
  4217: '0x0000000000000000000000000000000000000000',
  42431: '0x0000000000000000000000000000000000000000',
} as const

const registry: Record<string, Record<number, readonly Address[]>> = {
  USD: usd,
}

export function isSymbolic(currency: string): boolean {
  return currency.toUpperCase() in registry
}

export function resolve(
  currency: string,
  chainId: number,
): { currency: string; acceptedCurrencies?: readonly string[]; dexRouter?: string } {
  const tokens = registry[currency.toUpperCase()]
  if (!tokens) return { currency }

  const chainTokens = tokens[chainId]
  if (!chainTokens?.length) {
    throw new Error(`No tokens configured for currency "${currency}" on chain ${chainId}.`)
  }

  const router = dexRouter[chainId]
  return {
    currency: chainTokens[0]!,
    acceptedCurrencies: chainTokens,
    ...(router && { dexRouter: router }),
  }
}
