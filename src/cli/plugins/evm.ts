import type { Address } from 'viem'

import { evm as evmMethods } from '../../evm/client/index.js'
import * as x402_ChallengeBrand from '../../x402/internal/ChallengeBrand.js'
import { resolveAccount } from '../account.js'
import { knownCurrencies, readTokenSymbol, resolveEvmChain } from './internal.js'
import { createPlugin } from './plugin.js'

export function evm() {
  return createPlugin({
    method: 'evm',

    // Branded x402 challenges also arrive as `evm/charge`; those belong to the x402 plugin.
    supports: (challenge) => challenge.method === 'evm' && !x402_ChallengeBrand.is(challenge),

    async setup({ challenge }) {
      const request = challenge.request as Record<string, unknown>
      const methodDetails = request.methodDetails as Record<string, unknown> | undefined
      const chainId = methodDetails?.chainId as number | undefined
      const chain = chainId ? resolveEvmChain(chainId) : undefined
      const currency = request.currency as string | undefined

      const account = await resolveAccount()

      let tokenSymbol = currency ?? ''
      if (chain && currency)
        tokenSymbol = (await readTokenSymbol(chain, currency as Address)) ?? tokenSymbol

      return {
        tokenSymbol,
        tokenDecimals: (methodDetails?.decimals as number | undefined) ?? 6,
        explorerUrl: chain?.blockExplorers?.default?.url,
        methods: [...evmMethods({ account, currencies: knownCurrencies })],
      }
    },
  })
}
