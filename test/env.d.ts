/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TEMPO_NETWORK: 'localnet' | 'moderato' | 'devnet' | 'none'
  readonly VITE_HTTP_LOG: string
  readonly VITE_RPC_CREDENTIALS: string
  readonly VITE_RPC_URL: string
  readonly VITE_STRIPE_PUBLIC_KEY: string
  readonly VITE_STRIPE_SECRET_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
