// Web Bot Auth with MPP on Cloudflare Workers — Example
//
// A paid report API that only trusted bots may call. Every request to
// /api/report must carry a Web Bot Auth signature (HTTPS-directory profile)
// from a trusted bot key; the server verifies the bot before it issues or
// accepts an MPP payment challenge. Routes without `identity` stay open.
//
// Signature nonces and spent payment credentials live in Durable Objects
// through `Store.durableObject()`, so a signature or credential accepted on
// one isolate can't be replayed on another.
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores nonces and credentials, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives payments. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs. */
  MPP_SECRET_KEY: string
  /** Public JWK of the trusted bot's Ed25519 signing key. */
  BOT_PUBLIC_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// pathUSD on Tempo testnet (6 decimals).
const currency = '0x20c0000000000000000000000000000000000000' as const
// The trusted bot's HTTPS directory. The verifier never fetches the
// caller-controlled `Signature-Agent` URL: this example trusts one key for it.
const signatureAgent = 'https://bot.example'

let server: ReturnType<typeof createServer> | undefined
async function createServer(env: Env) {
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.BOT_PUBLIC_KEY) as JsonWebKey,
    { name: 'Ed25519' },
    true,
    ['verify'],
  )
  const store = Store.durableObject(env.MPPX_STORE)
  const webBotAuth = WebBotAuth.Server.verifier({
    // Applies the trust policy, then returns the public key. The verifier
    // also checks that the keyid is this key's RFC 7638 thumbprint.
    keyResolver(parameters) {
      if (parameters.signatureAgent !== signatureAgent) return undefined
      return publicKey
    },
    maxAge: 60,
    nonceStore: store,
  })
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  const mppx = Mppx.create({
    secretKey: env.MPP_SECRET_KEY,
    methods: [
      tempo({
        chainId: Chain.testnet.id,
        currency,
        getClient: () => client,
        recipient: account.address,
        store,
      }),
    ],
  })
  return { mppx, webBotAuth }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })
    if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

    server ??= createServer(env)
    const { mppx, webBotAuth } = await server
    const result = await mppx.charge({ amount: '0.01', identity: [webBotAuth] })(request)

    // An untrusted or unsigned request gets the identity rejection (401/403);
    // a trusted bot without payment gets the 402 challenge.
    if (result.status === 402) return result.challenge

    // The verified key ID and directory of the bot that signed the request.
    const bot = result.identity?.get(webBotAuth)
    return result.withReceipt(Response.json({ report: 'Quarterly crawl report', bot }))
  },
}
