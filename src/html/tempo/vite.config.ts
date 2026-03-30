import { tempoModerato } from 'viem/chains'
import { defineConfig } from 'vite'

import * as Methods from '../../tempo/Methods.js'
import mppx from '../vite.js'

const accountsPrivateKey = process.env.MPPX_TEMPO_ACCOUNTS_PRIVATE_KEY
const tempoRpcUrl = process.env.TEMPO_RPC_URL
const tempoChainId = Number(process.env.TEMPO_CHAIN_ID ?? tempoModerato.id)

export default defineConfig({
  plugins: [
    mppx({
      method: Methods.charge,
      output: '../../tempo/server/internal/html.gen.ts',
      ...(accountsPrivateKey || tempoRpcUrl
        ? {
            config: {
              ...(accountsPrivateKey ? { accountsPrivateKey } : {}),
              ...(tempoRpcUrl ? { rpcUrls: { [tempoChainId]: tempoRpcUrl } } : {}),
            },
          }
        : {}),
      challenge: {
        request: {
          amount: '1',
          currency: '0x20c0000000000000000000000000000000000001', // AlphaUSD
          decimals: 6,
          description: 'Test payment',
          recipient: '0x0000000000000000000000000000000000000002',
          chainId: tempoChainId,
        },
        description: 'Test payment',
      },
    }),
  ],
})
