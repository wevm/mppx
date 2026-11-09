// Onchain KYC registry with MPP on Cloudflare Workers — Example
//
// A paid API that only KYC'd payers may use. The operator keeps the list of
// verified addresses in a contract (contracts/KycRegistry.sol). Every 402 from
// /api/report carries `Identity-Required: kyc;issuer="eip155:<chainId>:<registry>"`.
// On the paid retry, before the payment settles, the server reads the registry
// for the payer's address: a listed payer pays and gets the report, any other
// payer gets 403. The route offers pull mode only, so the client signs and the
// server broadcasts the payment after the check: a rejected payment is never sent.
//
// Set COINBASE_VERIFIED=true to require a Coinbase Verified Account attestation
// on Base instead of your own registry.
import * as Onchain from 'mppx/extensions/identity/onchain'
import { Mppx, Store, tempo } from 'mppx/server'
import { type Address, createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
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
  /** Address of the KYC registry contract on Tempo testnet. */
  KYC_REGISTRY?: string | undefined
  /** Optional: `true` to require a Coinbase Verified Account on Base instead. */
  COINBASE_VERIFIED?: string | undefined
  /** Optional Base RPC URL for COINBASE_VERIFIED. Defaults to the public RPC. */
  BASE_RPC_URL?: string | undefined
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// pathUSD on Tempo testnet (6 decimals).
const currency = '0x20c0000000000000000000000000000000000000' as const

let server: ReturnType<typeof createServer> | undefined
function createServer(env: Env) {
  const client = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  const kyc =
    env.COINBASE_VERIFIED === 'true'
      ? Onchain.Server.coinbase({
          client: createClient({ chain: base, transport: http(env.BASE_RPC_URL) }),
        })
      : Onchain.Server.registry({ client, registry: registryAddress(env) })
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
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
  return { kyc, mppx }
}

function registryAddress(env: Env): Address {
  if (!env.KYC_REGISTRY) throw new Error('Set KYC_REGISTRY to the registry contract address.')
  return env.KYC_REGISTRY as Address
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })
    if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

    server ??= createServer(env)
    const { kyc, mppx } = server
    const result = await mppx.charge({
      amount: '0.01',
      identity: { payment: kyc },
      // Pull mode: the server broadcasts only after the check passes.
      supportedModes: ['pull'],
    })(request)

    // An unpaid request gets the 402. A payer the registry does not list gets
    // 403, and an unreadable registry 503, before the payment settles.
    if (result.status === 402) return result.challenge

    // The payer the registry allowed.
    const payer = result.identity?.get(kyc)
    return result.withReceipt(
      Response.json({ report: 'Quarterly usage report', payer: payer?.address }),
    )
  },
}
