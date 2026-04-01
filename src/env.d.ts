/// <reference types="vite/client" />

declare const __TEST__: boolean

interface ImportMetaEnv {
  readonly VITE_NODE_ENV: 'localnet' | 'testnet' | 'mainnet'
  readonly VITE_HTTP_LOG: 'true' | 'false'
  readonly VITE_RPC_CREDENTIALS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
