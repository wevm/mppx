import { type Address, type Chain, createClient, erc20Abi, http } from 'viem'
import { readContract } from 'viem/actions'
import * as viemChains from 'viem/chains'

import { evm as evmMethods, assets as evmAssets } from '../../evm/client/index.js'
import * as x402_ChallengeBrand from '../../x402/internal/ChallengeBrand.js'
import { resolveAccount } from '../account.js'
import { createPlugin } from './plugin.js'

export function evm() {
  return createPlugin({
    method: 'evm',
    supports: (challenge) => challenge.method === 'evm' && !x402_ChallengeBrand.is(challenge),

    async setup({ challenge }) {
      const request = challenge.request as Record<string, unknown>
      const methodDetails = request.methodDetails as Record<string, unknown> | undefined
      const chainId = methodDetails?.chainId as number | undefined
      const chain = chainId ? resolveChain(chainId) : undefined
      const currency = request.currency as string | undefined

      const account = await resolveAccount()
      // Known assets provide EIP-712 domain metadata (token name/version) needed for EIP-3009 signing
      const knownCurrencies = [
        ...Object.values(evmAssets.base),
        ...Object.values(evmAssets.baseSepolia),
        ...Object.values(evmAssets.celo),
        ...Object.values(evmAssets.celoSepolia),
      ]

      let tokenSymbol = currency ?? ''
      if (chain && currency) {
        try {
          const client = createClient({ chain, transport: http() })
          const symbol = await readContract(client, {
            address: currency as Address,
            abi: erc20Abi,
            functionName: 'symbol',
          })
          if (symbol) tokenSymbol = symbol
        } catch {}
      }

      return {
        tokenSymbol,
        tokenDecimals: (methodDetails?.decimals as number | undefined) ?? 6,
        explorerUrl: chain?.blockExplorers?.default?.url,
        methods: [...evmMethods({ account, currencies: knownCurrencies })],
      }
    },
  })
}

function resolveChain(chainId: number): Chain | undefined {
  const all = Object.values(viemChains) as Chain[]
  return all.find((c) => c.id === chainId)
}
