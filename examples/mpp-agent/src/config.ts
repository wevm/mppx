import { tempo, tempoModerato } from 'viem/chains'
import { pathusd, usdce } from 'viem/tokens'

const env = process.env
const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d)

const NETWORKS = {
  mainnet: {
    chain: tempo,
    token: usdce(tempo.id).address.toLowerCase() as `0x${string}`,
    symbol: 'USDC.e',
  },
  testnet: {
    chain: tempoModerato,
    token: pathusd(tempoModerato.id).address.toLowerCase() as `0x${string}`,
    symbol: 'pathUSD',
  },
} as const

export type Network = keyof typeof NETWORKS
const network: Network = env.MPP_NETWORK === 'testnet' ? 'testnet' : 'mainnet'

// auto: the Tempo Wallet access key if one is stored, else a local demo wallet key (legacy), else "run setup".
// tempo-wallet / keychain / file / env force one mode (env is for CI and the testnet e2e).
const KEY_SOURCES = ['auto', 'tempo-wallet', 'keychain', 'file', 'env'] as const
export type KeySource = (typeof KEY_SOURCES)[number]
// keychain on macOS, a 0600 file elsewhere (Linux)
const store = (v?: string): 'file' | 'keychain' =>
  v === 'file' || v === 'keychain' ? v : process.platform === 'darwin' ? 'keychain' : 'file'

export const config = {
  port: num('PORT', 3000),
  keySource: (KEY_SOURCES.includes(env.MPP_KEY_SOURCE as KeySource)
    ? env.MPP_KEY_SOURCE
    : 'auto') as KeySource,
  legacyStore: store(), // where a local demo wallet key lives when no raw-key mode is forced
  keyFile: env.MPP_KEY_FILE ?? `${env.HOME ?? '.'}/.mpp-agent/key`,
  // the Tempo Wallet access key and its signed authorization (never the tempo CLI's own ~/.tempo store)
  accessKeyStore: store(env.MPP_ACCESS_KEY_STORE),
  accessKeyFile: env.MPP_ACCESS_KEY_FILE ?? `${env.HOME ?? '.'}/.mpp-agent/access-key.json`,
  dustUsd: 0.01, // below this a wallet counts as empty (migration, --forget-local-key)
  network,
  ...NETWORKS[network],
  explorer: NETWORKS[network].chain.blockExplorers.default.url,
  model: env.MODEL ?? 'anthropic/claude-sonnet-4.5',
  llmUrl: env.LLM_URL ?? 'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
  budget: {
    totalUsd: num('BUDGET_TOTAL_USD', 1.5),
    inferenceUsd: num('BUDGET_INFERENCE_USD', 0.5),
    toolsUsd: num('BUDGET_TOOLS_USD', 1.0),
    perCallUsd: num('MAX_PER_CALL_USD', 0.6),
  },
  maxSteps: num('MAX_STEPS', 25),
  callTimeoutMs: num('CALL_TIMEOUT_MS', 300_000), // per HTTP call incl. its paid retry; media generation can take ~90s
  // wait_for (async jobs): each poll is a normal call (per-call timeout above, policy, budget); these bound the polling itself
  jobs: {
    maxPollsPerWait: 60,
    maxPollsPerRun: num('MAX_POLLS_PER_RUN', 150),
    everyS: [2, 60, 5],
    timeoutS: [10, 900, 300],
  } as {
    maxPollsPerWait: number
    maxPollsPerRun: number
    everyS: [min: number, max: number, dflt: number]
    timeoutS: [min: number, max: number, dflt: number]
  },
  allowSideEffectHosts: (env.ALLOW_SIDE_EFFECT_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dryRun: env.DRY_RUN === '1', // deny every payment: probe quotes, never pay
  proxy: env.HTTPS_PROXY ?? env.https_proxy,
}
