/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE: 'test' | 'production'
  readonly VITE_TEMPO_NETWORK: 'localnet' | 'moderato' | 'devnet'
  readonly VITE_HTTP_LOG: 'true' | 'false'
  readonly VITE_RPC_CREDENTIALS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
