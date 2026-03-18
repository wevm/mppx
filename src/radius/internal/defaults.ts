import type { ValueOf } from '../../internal/types.js'

export const chainId = {
  mainnet: 723,
  testnet: 72344,
} as const
export type ChainId = ValueOf<typeof chainId>

/** Token addresses. */
export const tokens = {
  /** SBC token address (mainnet only, 6 decimals). */
  sbc: '0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb',
} as const

/**
 * Chain ID → default currency.
 *
 * On mainnet the default settlement token is SBC (6 decimals).
 * On testnet the native RUSD is used directly — set `currency` explicitly
 * when configuring a testnet method.
 */
export const currency = {
  [chainId.mainnet]: tokens.sbc,
} as const satisfies Partial<Record<ChainId, string>>

/**
 * Default token decimals for SBC on Radius mainnet.
 *
 * SBC uses 6 decimals.  The native RUSD uses 18 decimals — callers
 * targeting RUSD **must** set `decimals: 18` explicitly.
 */
export const decimals = 6

/** Default RPC URLs for each Radius chain. */
export const rpcUrl = {
  [chainId.mainnet]: 'https://rpc.radiustech.xyz',
  [chainId.testnet]: 'https://rpc.testnet.radiustech.xyz',
} as const satisfies Record<ChainId, string>

/** Resolves the default currency. */
export function resolveCurrency(parameters: {
  /** Chain ID. */
  chainId?: number | undefined
  /** Whether in testnet mode. */
  testnet?: boolean | undefined
}): string | undefined {
  const id = parameters.chainId ?? (parameters.testnet ? chainId.testnet : chainId.mainnet)
  return currency[id as keyof typeof currency]
}
