import { tempoLocalnet, tempoModerato } from 'viem/tempo/chains'

const env =
  import.meta.env ??
  (typeof process !== 'undefined'
    ? (process.env as Partial<Record<keyof ImportMetaEnv, string>>)
    : {})

type TempoNetwork = 'localnet' | 'moderato'

function parseNetwork(value: string | undefined): TempoNetwork {
  if (value === undefined || value === '' || value === 'localnet') return 'localnet'
  if (value === 'moderato' || value === 'devnet') return 'moderato'
  throw new Error(`Unsupported Tempo network "${value}". Use "localnet" or "moderato".`)
}

export const tempoNetwork = parseNetwork(env.VITE_TEMPO_NETWORK)
export const rpcUrl = env.VITE_RPC_URL || undefined

export const chain = tempoNetwork === 'localnet' ? tempoLocalnet : tempoModerato
export const isLocalnet = chain.id === tempoLocalnet.id
export const networkName = isLocalnet ? 'Tempo Localnet' : 'Tempo Moderato'
export const transportOptions = isLocalnet ? { retryCount: 0, timeout: 60_000 } : undefined
