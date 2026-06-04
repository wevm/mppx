declare module '*.css'

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string | undefined
  readonly VITE_TEMPO_NETWORK?: 'localnet' | 'moderato' | 'devnet' | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
