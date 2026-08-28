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

/** Pays recognized x402 exact EVM challenges with the configured CLI account. */
export function x402() {
  return createPlugin({
    method: 'evm',
    supports: isSupportedChallenge,

    async setup({ challenge, options }) {
      const request = challenge.request as {
        asset?: Address | undefined
        extra?: Record<string, unknown> | undefined
        network?: x402_Types.EvmNetwork | undefined
      }
      const chain = request.network ? resolveEvmChain(Assets.toChainId(request.network)) : undefined
      const known =
        request.network && request.asset
          ? knownAssets.find(([, asset]) => Assets.matches(asset, request.asset!, request.network!))
          : undefined
      const name = request.extra?.name
      const version = request.extra?.version
      const currency =
        request.asset && request.network && typeof name === 'string' && typeof version === 'string'
          ? Assets.define({
              address: request.asset,
              decimals: known?.[1].decimals ?? 6,
              network: request.network,
              transfer: { name, type: 'eip3009', version },
            })
          : undefined
      const account = await resolveAccount(options.account)

      return {
        explorerUrl: chain?.blockExplorers?.default?.url,
        methods: [...evmMethods({ account, ...(currency && { currencies: [currency] }) })],
        tokenDecimals: known?.[1].decimals ?? 6,
        tokenSymbol: known?.[0] ?? '',
      }
    },
  })
}

/** Returns whether the CLI can create an x402 credential for this challenge. */
function isSupportedChallenge(challenge: { request: Record<string, unknown> }): boolean {
  if (!x402_ChallengeBrand.is(challenge)) return false
  const request = challenge.request
  const transfer = request.extra as Record<string, unknown> | undefined
  const transferMethod = transfer?.assetTransferMethod
  return (
    request.scheme === 'exact' &&
    typeof request.asset === 'string' &&
    typeof request.network === 'string' &&
    typeof transfer?.name === 'string' &&
    typeof transfer?.version === 'string' &&
    (transferMethod === undefined || transferMethod === 'eip3009')
  )
}

function resolveEvmChain(chainId: number): Chain | undefined {
  return (Object.values(viemChains) as Chain[]).find((chain) => chain.id === chainId)
}
