import type { ValueOf } from '../../internal/types.js'

export const chainId = {
  mainnet: 1329,
  testnet: 713715,
} as const
export type ChainId = ValueOf<typeof chainId>

/** Token addresses. */
export const tokens = {
  /** USDC token address. */
  usdc: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
  /** USDT token address. */
  usdt: '0xB75D0B03c06A926e488e2659DF1A861F860bD3d1',
} as const

/** Chain ID → default currency. */
export const currency = {
  [chainId.mainnet]: tokens.usdc,
  [chainId.testnet]: tokens.usdc,
} as const satisfies Record<ChainId, string>

/** Default RPC URLs for each Sei chain. */
export const rpcUrl = {
  [chainId.mainnet]: 'https://evm-rpc.sei-apis.com',
  [chainId.testnet]: 'https://evm-rpc-testnet.sei-apis.com',
} as const satisfies Record<ChainId, string>

/** Default token decimals for Sei stablecoins. */
export const decimals = 6

/** Resolves the default currency. */
export function resolveCurrency(parameters: {
  /** Chain ID. */
  chainId?: number | undefined
  /** Whether in testnet mode. */
  testnet?: boolean | undefined
}): string {
  const id = parameters.chainId ?? (parameters.testnet ? chainId.testnet : chainId.mainnet)
  return currency[id as keyof typeof currency] ?? tokens.usdc
}
