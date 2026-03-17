import type { ValueOf } from '../../internal/types.js'

export const chainId = {
  mainnet: 4217,
  testnet: 42431,
} as const
export type ChainId = ValueOf<typeof chainId>

/** Token addresses. */
export const tokens = {
  /** USDC (USDC.e) token address. */
  usdc: '0x20C000000000000000000000b9537d11c60E8b50',
  /** pathUSD token address. */
  pathUsd: '0x20c0000000000000000000000000000000000000',
} as const

/** Chain ID → default currency. */
export const currency = {
  [chainId.mainnet]: tokens.usdc,
  [chainId.testnet]: tokens.pathUsd,
} as const satisfies Record<ChainId, string>

/**
 * Default token decimals for TIP-20 stablecoins (e.g. pathUSD, USDC).
 *
 * All TIP-20 tokens on Tempo use 6 decimals, so there is no risk of
 * client/server mismatch within the Tempo ecosystem. Other chains and
 * runtimes should set `decimals` explicitly to match their token.
 */
export const decimals = 6

/** Default payment-channel escrow contract addresses per chain. */
export const escrowContract = {
  [chainId.mainnet]: '0x33b901018174DDabE4841042ab76ba85D4e24f25',
  [chainId.testnet]: '0x542831e3E4Ace07559b7C8787395f4Fb99F70787',
} as const satisfies Record<ChainId, string>

/** Default RPC URLs for each Tempo chain. */
export const rpcUrl = {
  [chainId.mainnet]: 'https://rpc.tempo.xyz',
  [chainId.testnet]: 'https://rpc.moderato.tempo.xyz',
} as const satisfies Record<ChainId, string>

/** Resolves the default currency. */
export function resolveCurrency(parameters: {
  /** Chain ID. */
  chainId?: number | undefined
  /** Whether in testnet mode. */
  testnet?: boolean | undefined
}): string {
  const id = parameters.chainId ?? (parameters.testnet ? chainId.testnet : chainId.mainnet)
  return currency[id as keyof typeof currency] ?? tokens.pathUsd
}
