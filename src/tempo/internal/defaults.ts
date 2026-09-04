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

/** Canonical first-party machine-token deployments used by charges and sessions. */
export const machineToken = {
  [chainId.mainnet]: {
    swap: '0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F',
    token: '0x20c000000000000000000000f37de3740ADec032',
  },
  [chainId.testnet]: {
    swap: '0xd05f8EdFBB54Da0d765C9fE9b2B3f7d2E3a8C466',
    token: '0x20c000000000000000000000f37de3740ADec032',
  },
} as const satisfies Partial<Record<ChainId, { swap: `0x${string}`; token: `0x${string}` }>>

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
  [chainId.testnet]: '0xe1c4d3dce17bc111181ddf716f75bae49e61a336',
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
