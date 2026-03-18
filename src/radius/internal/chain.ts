import { defineChain } from 'viem'

const costApi = {
  mainnet: 'https://network.radiustech.xyz/api/v1/network/transaction-cost',
  testnet: 'https://testnet.radiustech.xyz/api/v1/network/transaction-cost',
} as const

/**
 * Fetches the current gas price from the Radius cost API.
 *
 * Radius uses a fixed gas price (~1 gwei) with priority fee always 0.
 * viem's default EIP-1559 estimation returns 0 on Radius, so we must
 * override `estimateFeesPerGas` to query the cost API directly.
 */
function makeFeesEstimator(url: string) {
  return {
    async estimateFeesPerGas() {
      const res = await fetch(url)
      const json = (await res.json()) as { gas_price_wei: string }
      const gasPrice = BigInt(json.gas_price_wei)
      return {
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: 0n,
      }
    },
  }
}

/** Radius mainnet chain definition for viem. */
export const radiusMainnet = /*#__PURE__*/ defineChain({
  id: 723,
  name: 'Radius',
  nativeCurrency: { decimals: 18, name: 'RUSD', symbol: 'RUSD' },
  rpcUrls: {
    default: { http: ['https://rpc.radiustech.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Radius Explorer', url: 'https://network.radiustech.xyz' },
  },
  fees: makeFeesEstimator(costApi.mainnet),
})

/** Radius testnet chain definition for viem. */
export const radiusTestnet = /*#__PURE__*/ defineChain({
  id: 72344,
  name: 'Radius Testnet',
  nativeCurrency: { decimals: 18, name: 'RUSD', symbol: 'RUSD' },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.radiustech.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Radius Explorer', url: 'https://testnet.radiustech.xyz' },
  },
  fees: makeFeesEstimator(costApi.testnet),
})
