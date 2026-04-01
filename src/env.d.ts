/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE: 'test' | 'production'
  readonly VITE_NODE_ENV: 'localnet' | 'testnet' | 'mainnet'
  readonly VITE_HTTP_LOG: 'true' | 'false'
  readonly VITE_RPC_CREDENTIALS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
