import type { Address } from 'viem'

import { evm as evmMethods } from '../../evm/client/index.js'
import * as Assets from '../../x402/Assets.js'
import * as x402_ChallengeBrand from '../../x402/internal/ChallengeBrand.js'
import type * as x402_Types from '../../x402/Types.js'
import { resolveAccount } from '../account.js'
import { findKnownAsset, knownCurrencies, readTokenSymbol, resolveEvmChain } from './internal.js'
import { createPlugin } from './plugin.js'

/**
 * Pays x402 `exact` challenges.
 *
 * They reach the CLI as `evm/charge`, the same shape a native EVM challenge has, so this
 * plugin claims them by their brand and leaves the native ones to `evm()`. The token lives
 * under `asset` on a CAIP-2 `network` rather than under `currency` with a chain ID, which is
 * the only reason the display side differs at all: signing is the same method either way.
 */
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
          ? findKnownAsset(request.network, request.asset)
          : undefined

      const [account, readSymbol] = await Promise.all([
        resolveAccount(options.account),
        known?.symbol || !chain || !request.asset
          ? undefined
          : readTokenSymbol(chain, request.asset),
      ])
      const tokenSymbol = known?.symbol ?? readSymbol ?? ''

      return {
        explorerUrl: chain?.blockExplorers?.default?.url,
        methods: [...evmMethods({ account, currencies: knownCurrencies })],
        tokenDecimals: known?.decimals ?? 6,
        tokenSymbol,
      }
    },
  })
}
