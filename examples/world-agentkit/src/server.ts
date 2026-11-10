// Human-backed agents with World AgentKit — Example
//
// `/api/report` costs 0.01 pathUSD on Tempo testnet. Agents backed by a World
// ID-verified human (registered in World's AgentBook) get their first report
// free, once per human however many agents they run, like x402's AgentKit
// `free-trial` mode. Everyone else pays the normal MPP 402.
//
//   pnpm server                               # AgentBook on World Chain mainnet
//   WORLD_RPC_URL=http://127.0.0.1:8545 pnpm server   # AgentBook on a local fork
import * as http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import * as World from 'mppx/extensions/identity/world'
import { Mppx, Request, Store, tempo } from 'mppx/server'
import { createClient, http as transport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

const PORT = Number(process.env.PORT ?? 4021)
const FREE_USES = 1

// One durable, atomic store for payment replays, AgentKit nonces and free-trial counts, so
// they survive restarts. Point several instances at one shared store, such as Store.postgres()
// or Store.redis(), to run more than one.
const store = Store.sqlite(new DatabaseSync(process.env.DB_PATH ?? 'world-agentkit.db'))

const payee = privateKeyToAccount(generatePrivateKey())
const mppx = Mppx.create({
  // Set MPP_SECRET_KEY so Challenges stay valid across restarts and instances.
  secretKey:
    process.env.MPP_SECRET_KEY ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
  methods: [
    tempo({
      chainId: Chain.testnet.id,
      getClient: () => createClient({ chain: Chain.testnet, transport: transport() }),
      recipient: payee.address,
      store,
    }),
  ],
})

// Verifies the `agentkit` header and resolves the agent to its human in AgentBook.
const human = World.Server.verifier({
  // Use your own World Chain RPC in production: any request can trigger a lookup.
  rpcUrl: process.env.WORLD_RPC_URL ?? World.Constants.rpcUrl,
  nonceStore: store,
  // The origin agents sign for. Without it, the Host header decides, so a header signed for
  // another site could be replayed here.
  origins: [process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`],
})

/** Atomically uses one of a human's free reports: false once they are all used. */
async function useFreeReport(humanId: string): Promise<boolean> {
  return store.update(`free:${humanId}`, (current) => {
    const count = typeof current === 'number' ? current : 0
    if (count >= FREE_USES) return { op: 'noop', result: false }
    return { op: 'set', value: count + 1, result: true }
  })
}

async function handle(request: globalThis.Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

  const identity = await human.verify(request)
  if (identity.status === 'valid' && (await useFreeReport(identity.value.humanId)))
    return Response.json({
      report: 'Q3 cross-border volume: $41.2M (+18%)',
      paid: false,
      humanId: identity.value.humanId,
    })
  if (identity.status === 'forbidden') console.log(`  agentkit: ${identity.reason}`)

  const result = await mppx.charge({ amount: '0.01', description: 'Market report' })(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(
    Response.json({
      report: 'Q3 cross-border volume: $41.2M (+18%)',
      paid: true,
      ...(identity.status === 'valid' && { humanId: identity.value.humanId }),
    }),
  )
}

http
  .createServer(Request.toNodeListener(handle))
  .listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`))
