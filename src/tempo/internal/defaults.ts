import { getAddress } from 'viem'
import { ousd, pathusd, usdce } from 'viem/tokens'

import type { ValueOf } from '../../internal/types.js'

export const chainId = {
  mainnet: 4217,
  testnet: 42431,
} as const
export type ChainId = ValueOf<typeof chainId>

/** Token addresses. */
export const tokens = {
  /** OpenUSD (OUSD), deployed at the same address on Tempo mainnet and Moderato. */
  ousd: ousd(chainId.mainnet).address,
  /** USDC (USDC.e) token address. */
  usdc: getAddress(usdce(chainId.mainnet).address),
  /** pathUSD token address. */
  pathUsd: pathusd(chainId.mainnet).address,
} as const

/** Chain ID → default currency. */
export const currency = {
  [chainId.mainnet]: tokens.usdc,
  [chainId.testnet]: tokens.pathUsd,
} as const satisfies Record<ChainId, string>

/** Immutable canonical first-party machine-token deployments used by charge routes. */
export const machineToken = Object.freeze({
  [chainId.mainnet]: Object.freeze({
    swap: '0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F',
    token: '0x20c000000000000000000000f37de3740ADec032',
  }),
  [chainId.testnet]: Object.freeze({
    swap: '0xd05f8EdFBB54Da0d765C9fE9b2B3f7d2E3a8C466',
    token: '0x20c000000000000000000000f37de3740ADec032',
  }),
} as const) satisfies Readonly<
  Partial<Record<ChainId, Readonly<{ swap: `0x${string}`; token: `0x${string}` }>>>
>

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
