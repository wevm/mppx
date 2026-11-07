// Email OTP identity with MPP on Cloudflare Workers — Example
//
// A paid API that only callers with a verified email address may use. A
// request to /api/report without an email attestation gets 401 with
// `Identity-Attestation-Required: email;issuer="…"`. The client gets a
// one-time code by email from that issuer, exchanges it for an attestation
// bound to this server's origin, and sends it in `Identity-Attestation`.
// Only then does the server issue or accept an MPP payment challenge.
import * as EmailOtp from 'mppx/extensions/identity/email-otp'
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores spent credentials, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives payments. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs. */
  MPP_SECRET_KEY: string
  /** URL of the email attestation issuer this server trusts. */
  IDENTITY_ISSUER: string
  /** Optional: only accept addresses at this domain, such as `example.com`. */
  ALLOWED_EMAIL_DOMAIN?: string | undefined
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// pathUSD on Tempo testnet (6 decimals).
const currency = '0x20c0000000000000000000000000000000000000' as const

let server: ReturnType<typeof createServer> | undefined
function createServer(env: Env) {
  const email = EmailOtp.Server.verifier({
    // Attestations must be bound to this server's origin. A Worker only receives
    // requests for the hosts routed to it, so its request URL's origin is safe here.
    audience: (request) => new URL(request.url).origin,
    issuer: env.IDENTITY_ISSUER,
    // Route policy: which verified addresses may call the API.
    allow: (address) =>
      !env.ALLOWED_EMAIL_DOMAIN || address.endsWith(`@${env.ALLOWED_EMAIL_DOMAIN}`),
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
        store: Store.durableObject(env.MPPX_STORE),
      }),
    ],
  })
  return { email, mppx }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })
    if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

    server ??= createServer(env)
    const { email, mppx } = server
    const result = await mppx.charge({ amount: '0.01', identity: [email] })(request)

    // No or an invalid attestation gets 401 (a disallowed address 403);
    // a verified caller without payment gets the 402 challenge.
    if (result.status === 402) return result.challenge

    // The verified email address of the caller.
    const verified = result.identity?.get(email)
    return result.withReceipt(
      Response.json({ report: 'Quarterly usage report', email: verified?.email }),
    )
  },
}
