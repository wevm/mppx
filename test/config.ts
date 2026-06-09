import { tempoDevnet, tempoLocalnet } from 'viem/chains'

/** Tempo network setup mode used by tests. Use `none` for pure tests that do not need chain access. */
export type TempoNetwork = 'localnet' | 'moderato' | 'none'

/** Fully resolved Tempo network settings used by tests. */
export type TempoNetworkConfig = {
  chain: typeof tempoDevnet | typeof tempoLocalnet
  enabled: boolean
  isDevnet: boolean
  isLocalnet: boolean
  network: TempoNetwork
  rpcUrl: string
}

/** Default RPC URL for a Docker-backed Tempo localnet. */
export const tempoLocalnetRpcUrl = 'http://localhost:18545'

function resolveTempoNetwork(value: string | undefined): TempoNetwork {
  if (value === undefined || value === '' || value === 'localnet') return 'localnet'
  if (value === 'moderato' || value === 'devnet') return 'moderato'
  if (value === 'none') return 'none'
  throw new Error(
    `Unsupported Tempo test network "${value}". Use "localnet", "moderato", or "none".`,
  )
}

/** Resolves env-driven test network selection once for the whole suite. */
export function resolveTempoNetworkConfig(parameters: {
  network?: string | undefined
  rpcUrl?: string | undefined
}): TempoNetworkConfig {
  const network = resolveTempoNetwork(parameters.network)
  const isDevnet = network === 'moderato'
  const isLocalnet = network === 'localnet'
  return {
    chain: isDevnet ? tempoDevnet : tempoLocalnet,
    enabled: network !== 'none',
    isDevnet,
    isLocalnet,
    network,
    rpcUrl:
      parameters.rpcUrl ?? (isDevnet ? tempoDevnet.rpcUrls.default.http[0] : tempoLocalnetRpcUrl),
  }
}

export const tempoNetworkConfig = resolveTempoNetworkConfig({
  network: import.meta.env.VITE_TEMPO_NETWORK,
  rpcUrl: import.meta.env.VITE_RPC_URL,
})
export const tempoNetwork = tempoNetworkConfig.network
export const tempoRpcUrl = tempoNetworkConfig.rpcUrl
