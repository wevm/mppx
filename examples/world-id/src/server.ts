// Human-backed agents with World ID — Example
//
// `/api/report` requires an agent approved by a World ID-verified human. Each human's first
// report is free, however many agents they run; later ones cost 0.01 pathUSD on Tempo testnet.
// The server is World IdP's OpenID Connect client: it runs the device flow, so the person
// approves in World App and the server keeps their anonymous, pairwise subject.
//
//   WORLD_CLIENT_ID=... WORLD_CLIENT_SECRET=... pnpm server
import * as http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import * as World from 'mppx/extensions/identity/world'
import * as Identity from 'mppx/identity'
import { Mppx, Request, Store, tempo } from 'mppx/server'
import { createClient, http as transport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

const PORT = Number(process.env.PORT ?? 4021)
const FREE_USES = 1

// Set MPP_SECRET_KEY so Challenges and World ID sessions stay valid across restarts and instances.
const secretKey =
  process.env.MPP_SECRET_KEY ??
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

// One durable, atomic store for payment replays and free-trial counts, so they survive restarts.
// Point several instances at one shared store, such as Store.postgres() or Store.redis().
const store = Store.sqlite(new DatabaseSync(process.env.DB_PATH ?? 'world-id.db'))

const payee = privateKeyToAccount(generatePrivateKey())
const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo({
      chainId: Chain.testnet.id,
      getClient: () => createClient({ chain: Chain.testnet, transport: transport() }),
      recipient: payee.address,
      store,
    }),
  ],
})

// Register a confidential client at https://auth.world.org/portal (or the sandbox portal).
const human = World.Server.verifier({
  clientId: process.env.WORLD_CLIENT_ID!,
  clientSecret: process.env.WORLD_CLIENT_SECRET!,
  issuer: process.env.WORLD_ISSUER ?? World.Constants.issuer,
  secretKey,
  store,
})

/** Atomically uses one of a human's free reports: false once they are all used. */
async function useFreeReport(subject: string): Promise<boolean> {
  return store.update(`free:${subject}`, (current) => {
    const count = typeof current === 'number' ? current : 0
    if (count >= FREE_USES) return { op: 'noop', result: false }
    return { op: 'set', value: count + 1, result: true }
  })
}

async function handle(request: globalThis.Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

  // Without a session: 401 with World-Id-Required, and the client prover runs the device flow
  // through this route. Device-flow calls never verify, so they stop here too.
  const identity = await human.verify(request)
  if (identity.status !== 'valid')
    return new Response(identity.reason, {
      status: Identity.Status.codes[identity.status],
      headers: identity.headers,
    })
  const { subject } = identity.value
  const report = 'Q3 cross-border volume: $41.2M (+18%)'
  // The subject stays on the server: World ID asks to keep it out of agents' messages.
  if (await useFreeReport(subject)) return Response.json({ report, paid: false })

  const result = await mppx.charge({ amount: '0.01', description: 'Market report' })(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ report, paid: true }))
}

http
  .createServer(Request.toNodeListener(handle))
  .listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`))
