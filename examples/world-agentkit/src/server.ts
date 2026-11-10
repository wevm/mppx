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

import * as World from 'mppx/extensions/identity/world'
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, http as transport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

const PORT = Number(process.env.PORT ?? 4021)
const FREE_USES = 1

const payee = privateKeyToAccount(generatePrivateKey())
const mppx = Mppx.create({
  secretKey: crypto.getRandomValues(new Uint8Array(32)).toString(),
  methods: [
    tempo({
      chainId: Chain.testnet.id,
      getClient: () => createClient({ chain: Chain.testnet, transport: transport() }),
      recipient: payee.address,
      // Instance-local replay protection: use a shared store such as Store.redis() in production.
      store: Store.memory(),
    }),
  ],
})

// Verifies the `agentkit` header and resolves the agent to its human in AgentBook.
const human = World.Server.verifier({
  agentBook: { rpcUrl: process.env.WORLD_RPC_URL },
  nonceStore: Store.memory(),
})
// Free reports used, per human. Use durable storage in production.
const used = new Map<string, number>()

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

  const identity = await human.verify(request)
  if (identity.status === 'valid') {
    const { humanId } = identity.value
    const count = used.get(humanId) ?? 0
    if (count < FREE_USES) {
      used.set(humanId, count + 1)
      return Response.json({
        report: 'Q3 cross-border volume: $41.2M (+18%)',
        paid: false,
        humanId,
      })
    }
  } else if (identity.status === 'forbidden') {
    console.log(`  agentkit: ${identity.reason}`)
  }

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
  .createServer(async (req, res) => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(name, value)
    const response = await handle(
      new Request(new URL(req.url ?? '/', `http://${req.headers.host}`), { headers }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  .listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`))
