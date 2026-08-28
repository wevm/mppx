import type { Address, Chain } from 'viem'
import * as viemChains from 'viem/chains'

import { evm as evmMethods, assets as evmAssets } from '../../evm/client/index.js'
import * as Assets from '../../x402/Assets.js'
import * as x402_ChallengeBrand from '../../x402/internal/ChallengeBrand.js'
import type * as x402_Types from '../../x402/Types.js'
import { resolveAccount } from '../account.js'
import { createPlugin } from './plugin.js'

const knownAssets: readonly (readonly [string, Assets.KnownAsset])[] = [
  ...Object.entries(evmAssets.base),
  ...Object.entries(evmAssets.baseSepolia),
  ...Object.entries(evmAssets.celo),
  ...Object.entries(evmAssets.celoSepolia),
]
const knownCurrencies = knownAssets.map(([, asset]) => asset)

/** Pays recognized x402 exact EVM challenges with the configured CLI account. */
export function x402() {
  return createPlugin({
    method: 'evm',
    supports: (challenge) => x402_ChallengeBrand.is(challenge),

    async setup({ challenge, options }) {
      const request = challenge.request as {
        asset?: Address | undefined
        network?: x402_Types.EvmNetwork | undefined
      }
      const chain = request.network ? resolveEvmChain(Assets.toChainId(request.network)) : undefined
      const known =
        request.network && request.asset
          ? knownAssets.find(([, asset]) => Assets.matches(asset, request.asset!, request.network!))
          : undefined
      const account = await resolveAccount(options.account)

      return {
        explorerUrl: chain?.blockExplorers?.default?.url,
        methods: [...evmMethods({ account, currencies: knownCurrencies })],
        tokenDecimals: known?.[1].decimals ?? 6,
        tokenSymbol: known?.[0] ?? '',
      }
    },
  })
}

function resolveEvmChain(chainId: number): Chain | undefined {
  return (Object.values(viemChains) as Chain[]).find((chain) => chain.id === chainId)
}
