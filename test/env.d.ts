/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NODE_ENV: string
  readonly VITE_HTTP_LOG: string
  readonly VITE_RPC_CREDENTIALS: string
  readonly VITEST_POOL_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
