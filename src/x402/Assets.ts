import type { Asset, EvmNetwork, ExactTransfer } from './Types.js'

const knownAsset = Symbol('mppx.x402.asset')

/** Known x402 asset metadata. */
export type KnownAsset = Asset & {
  readonly [knownAsset]: true
  network: EvmNetwork
}

/** Creates typed x402 asset metadata for custom tokens. */
export function define(parameters: define.Parameters): KnownAsset {
  return {
    [knownAsset]: true,
    address: parameters.address,
    decimals: parameters.decimals,
    network: parameters.network,
    transfer: parameters.transfer,
  }
}

export declare namespace define {
  type Parameters = {
    address: `0x${string}`
    decimals: number
    network: EvmNetwork
    transfer: ExactTransfer
  }
}

/** Base network known assets. */
export const base = {
  USDC: define({
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    network: 'eip155:8453',
    transfer: {
      // USDC's EIP-712 domain name differs between Base and Base Sepolia.
      name: 'USD Coin',
      type: 'eip3009',
      version: '2',
    },
  }),
} as const

/** Base Sepolia known assets. */
export const baseSepolia = {
  USDC: define({
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    network: 'eip155:84532',
    transfer: {
      // Base Sepolia test USDC signs with the shorter EIP-712 domain name.
      name: 'USDC',
      type: 'eip3009',
      version: '2',
    },
  }),
} as const

/** Returns true when a value is known x402 asset metadata. */
export function isAsset(value: unknown): value is KnownAsset {
  if (typeof value !== 'object' || value === null) return false
  return (value as Partial<KnownAsset>)[knownAsset] === true
}
