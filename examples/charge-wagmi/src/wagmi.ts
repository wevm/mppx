import { Mppx, tempo } from 'mppx/client'
import { Chain } from 'viem/tempo'
import { createConfig, http } from 'wagmi'
import { getConnectorClient } from 'wagmi/actions'
import { metaMask } from 'wagmi/connectors'
import { webAuthn } from 'wagmi/tempo'

export const config = createConfig({
  chains: [Chain.testnet],
  connectors: [webAuthn(), metaMask()],
  transports: {
    [Chain.testnet.id]: http(),
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
