import { Mppx, tempo } from 'mppx/client'
import { createConfig, http } from 'wagmi'
import { getConnectorClient } from 'wagmi/actions'
import { tempoModerato } from 'wagmi/chains'
import { metaMask } from 'wagmi/connectors'
import { webAuthn } from 'wagmi/tempo'

export const config = createConfig({
  chains: [tempoModerato],
  connectors: [
    webAuthn(),
    metaMask(),
  ],
  transports: {
    [tempoModerato.id]: http(),
  },
})

export const mppx = Mppx.create({
  methods: [
    tempo({
      mode: 'push',
      getClient: () => getConnectorClient(config),
    }),
  ],
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
