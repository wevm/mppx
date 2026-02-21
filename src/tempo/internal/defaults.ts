export const rpcUrl = {
  4217: 'https://rpc.tempo.xyz',
  42431: 'https://rpc.moderato.tempo.xyz',
} as const

export const escrowContract = {
  4217: '0x0901aED692C755b870F9605E56BAA66C35BEfF69',
  42431: '0x542831e3E4Ace07559b7C8787395f4Fb99F70787',
} as const

export const mainnetChainId = 4217
export const testnetChainId = 42431

/** USDC (USDC.e) token address on Tempo. */
export const usdc = '0x20C000000000000000000000b9537d11c60E8b50'

/** pathUSD token address on Tempo. */
export const pathUsd = '0x20c0000000000000000000000000000000000000'

/** Chain ID → default currency mapping. Mainnet uses USDC, everything else uses pathUSD. */
const defaultCurrencies: Record<number, string> = {
  [mainnetChainId]: usdc,
  [testnetChainId]: pathUsd,
}

/** Returns the default currency for a chain ID. USDC for mainnet (4217), pathUSD otherwise. */
export function defaultCurrencyForChain(chainId: number | undefined): string {
  if (chainId === undefined) return pathUsd
  return defaultCurrencies[chainId] ?? pathUsd
}

/**
 * Default token decimals for TIP-20 stablecoins (e.g. pathUSD, USDC).
 *
 * All TIP-20 tokens on Tempo use 6 decimals, so there is no risk of
 * client/server mismatch within the Tempo ecosystem. Other chains and
 * runtimes should set `decimals` explicitly to match their token.
 */
export const decimals = 6
