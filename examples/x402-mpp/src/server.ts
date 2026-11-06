// x402 + mpp on Cloudflare Workers — Example
//
// One Hono app serves mpp, x402 and composed mpp-or-x402 payment routes
// (see `app.ts`). Tempo replay protection lives in Durable Objects through
// `Store.durableObject()`, so a credential can't be replayed on another isolate.
import { Store } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

import { createApp } from './app.js'

// The Durable Object class that stores spent credentials, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives payments and sponsors Tempo fees. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs. */
  MPP_SECRET_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
  /** Optional x402 facilitator URL. Defaults to https://facilitator.x402.rs. */
  X402_FACILITATOR_URL?: string | undefined
}

let app: ReturnType<typeof createApp> | undefined
function createAppFromEnv(env: Env) {
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const tempoClient = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  return createApp({
    account,
    facilitator: env.X402_FACILITATOR_URL,
    getTempoClient: () => tempoClient,
    secretKey: env.MPP_SECRET_KEY,
    store: Store.durableObject(env.MPPX_STORE),
  })
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    app ??= createAppFromEnv(env)
    return app.fetch(request)
  },
}
