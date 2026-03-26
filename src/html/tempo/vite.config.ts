import { tempoModerato } from 'viem/chains'
import { defineConfig } from 'vite'

import * as Methods from '../../tempo/Methods.js'
import mppx from '../vite.js'

export default defineConfig({
  plugins: [
    mppx({
      method: Methods.charge,
      output: '../../tempo/server/internal/html.gen.ts',
      challenge: {
        request: {
          amount: '1',
          currency: '0x20c0000000000000000000000000000000000001', // AlphaUSD
          decimals: 6,
          description: 'Test payment',
          recipient: '0x0000000000000000000000000000000000000002',
          chainId: Number(process.env.TEMPO_CHAIN_ID ?? tempoModerato.id),
        },
        description: 'Test payment',
      },
    }),
  ],
})
