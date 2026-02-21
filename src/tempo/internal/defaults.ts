export const mainnetChainId = 4217
export const testnetChainId = 42431

export type ChainId = typeof mainnetChainId | typeof testnetChainId

export const rpcUrl: Record<ChainId, string> = {
  [mainnetChainId]: 'https://rpc.tempo.xyz',
  [testnetChainId]: 'https://rpc.moderato.tempo.xyz',
}

export const escrowContract: Record<ChainId, `0x${string}`> = {
  [mainnetChainId]: '0x0901aED692C755b870F9605E56BAA66C35BEfF69',
  [testnetChainId]: '0x542831e3E4Ace07559b7C8787395f4Fb99F70787',
}

/** USDC (USDC.e) token address on Tempo. */
export const usdc = '0x20C000000000000000000000b9537d11c60E8b50'

/** pathUSD token address on Tempo. */
export const pathUsd = '0x20c0000000000000000000000000000000000000'

/** Chain ID → default currency. Mainnet uses USDC, everything else uses pathUSD. */
const defaultCurrencies: Record<ChainId, string> = {
  [mainnetChainId]: usdc,
  [testnetChainId]: pathUsd,
}

/** Returns the default currency for a chain ID. USDC for mainnet (4217), pathUSD otherwise. */
export function defaultCurrencyForChain(chainId: number | undefined): string {
  if (chainId === undefined) return pathUsd
  return defaultCurrencies[chainId as ChainId] ?? pathUsd
}

/**
 * Default token decimals for TIP-20 stablecoins (e.g. pathUSD, USDC).
 *
 * All TIP-20 tokens on Tempo use 6 decimals, so there is no risk of
 * client/server mismatch within the Tempo ecosystem. Other chains and
 * runtimes should set `decimals` explicitly to match their token.
 */
export const decimals = 6
