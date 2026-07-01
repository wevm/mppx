import { getAddress } from 'viem'
import type { Token } from 'viem/tokens'

import type { Asset, EvmNetwork, ExactTransfer } from './Types.js'

const knownAsset = Symbol('mppx.x402.asset')

/** Known x402 asset metadata. */
export type KnownAsset = Asset & {
  readonly [knownAsset]: true
  network: EvmNetwork
}

/** Viem token metadata from `viem/tokens`. */
export type ViemToken = Token

/** Currency metadata accepted by EVM and x402 payment config. */
export type Currency = `0x${string}` | KnownAsset | ViemToken

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

/** Creates x402 asset metadata from a `viem/tokens` token definition. */
export function fromToken(token: ViemToken, parameters: fromToken.Parameters): KnownAsset {
  const resolved = token(parameters.chainId)
  return define({
    address: resolved.address,
    decimals: resolved.decimals,
    network: toNetwork(parameters.chainId),
    transfer: withTokenDefaults(parameters.transfer, resolved),
  })
}

export declare namespace fromToken {
  type Parameters = {
    chainId: number
    transfer: Transfer
  }

  type Transfer =
    | (Omit<Extract<ExactTransfer, { type: 'eip3009' }>, 'name'> & {
        name?: string | undefined
      })
    | Extract<ExactTransfer, { type: 'permit2' }>
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

/** Returns true when a value is a `viem/tokens` token definition. */
export function isToken(value: unknown): value is ViemToken {
  return (
    typeof value === 'function' &&
    typeof (value as Partial<ViemToken>).addresses === 'object' &&
    typeof (value as Partial<ViemToken>).decimals === 'number'
  )
}

/** Returns true when a currency is a raw address without chain metadata. */
export function isRawAddress(currency: Currency): currency is `0x${string}` {
  return typeof currency === 'string'
}

/** Resolves currency metadata for an EVM network. */
export function resolve(currency: Currency, network: EvmNetwork): resolve.Result | undefined {
  if (isAsset(currency)) {
    if (currency.network !== network) return undefined
    return {
      address: currency.address,
      decimals: currency.decimals,
      transfer: currency.transfer,
    }
  }

  if (isToken(currency)) {
    const address = currency.addresses[toChainId(network)]
    if (!address) return undefined
    return {
      address,
      decimals: currency.decimals,
      name: currency.name,
    }
  }

  return {
    address: currency,
  }
}

export declare namespace resolve {
  type Result = {
    address: `0x${string}`
    decimals?: number | undefined
    name?: string | undefined
    transfer?: ExactTransfer | undefined
  }
}

/** Returns true when a currency resolves to the accepted address on the network. */
export function matches(
  currency: Currency,
  acceptedCurrency: `0x${string}`,
  network: EvmNetwork,
): boolean {
  const resolved = resolve(currency, network)
  if (!resolved) return false
  return getAddress(resolved.address) === acceptedCurrency
}

/** Converts an EVM chain ID to a CAIP-2 network identifier. */
export function toNetwork(chainId: number): EvmNetwork {
  return `eip155:${chainId}`
}

/** Converts a CAIP-2 EVM network identifier to a chain ID. */
export function toChainId(network: EvmNetwork): number {
  return Number(network.slice('eip155:'.length))
}

function withTokenDefaults(
  transfer: fromToken.Transfer,
  token: ReturnType<ViemToken>,
): ExactTransfer {
  if (transfer.type !== 'eip3009') return transfer
  if (transfer.name) return { ...transfer, name: transfer.name }
  if (!token.name) throw new Error('EIP-3009 token assets require a token name.')
  return {
    ...transfer,
    name: token.name,
  }
}
