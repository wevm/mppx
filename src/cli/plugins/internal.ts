import { type Address, type Chain, createClient, erc20Abi, http } from 'viem'
import { readContract } from 'viem/actions'
import * as viemChains from 'viem/chains'

import { assets as evmAssets } from '../../evm/client/index.js'
import * as Assets from '../../x402/Assets.js'
import type * as x402_Types from '../../x402/Types.js'

/** Known assets keyed by their symbol, across every network the client ships metadata for. */
const knownAssets = [
  ...Object.entries(evmAssets.base),
  ...Object.entries(evmAssets.baseSepolia),
  ...Object.entries(evmAssets.celo),
  ...Object.entries(evmAssets.celoSepolia),
]

/**
 * Every known currency, for handing to the EVM charge method.
 *
 * Known assets carry the EIP-712 domain metadata (token name and version) that EIP-3009
 * signing needs, which a bare token address cannot supply.
 */
export const knownCurrencies = knownAssets.map(([, asset]) => asset)

/** Known asset metadata for an address on a network, `undefined` when the token is not known. */
export function findKnownAsset(
  network: x402_Types.EvmNetwork,
  address: Address,
): { symbol: string; decimals: number } | undefined {
  const found = knownAssets.find(([, asset]) => Assets.matches(asset, address, network))
  if (!found) return undefined
  return { decimals: found[1].decimals, symbol: found[0] }
}

let chainById: Map<number, Chain> | undefined

/** The viem chain for an EVM chain ID, `undefined` when viem does not ship one. */
export function resolveEvmChain(chainId: number): Chain | undefined {
  chainById ??= new Map((Object.values(viemChains) as Chain[]).map((chain) => [chain.id, chain]))
  return chainById.get(chainId)
}

/** The token's on-chain symbol, `undefined` when it cannot be read. */
export async function readTokenSymbol(chain: Chain, address: Address): Promise<string | undefined> {
  try {
    const client = createClient({ chain, transport: http() })
    return await readContract(client, { abi: erc20Abi, address, functionName: 'symbol' })
  } catch {
    return undefined
  }
}
