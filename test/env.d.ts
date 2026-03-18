/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NODE_ENV: string
  readonly VITE_HTTP_LOG: string
  readonly VITE_RPC_CREDENTIALS: string
  readonly VITE_RPC_URL: string
  readonly VITE_TEMPO_TAG: string
  readonly VITE_STRIPE_PUBLIC_KEY: string
  readonly VITE_STRIPE_SECRET_KEY: string
  readonly VITE_RADIUS_NETWORK: string
  readonly VITE_RADIUS_RPC_URL: string
  readonly VITE_RADIUS_ALICE_PRIVATE_KEY: string
  readonly VITE_RADIUS_BOB_PRIVATE_KEY: string
  readonly VITEST_POOL_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
