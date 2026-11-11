// Human-backed agents with World ID — Example
//
// `/api/report` requires an agent approved by a World ID-verified human. Each human's first
// report is free, however many agents they run; later ones cost 0.01 pathUSD on Tempo testnet.
// A World ID issuer runs World IdP's device flow and attests the human. With World IdP
// credentials, this server runs one itself (self-hosted); otherwise it names a shared one.
//
//   WORLD_CLIENT_ID=... WORLD_CLIENT_SECRET=... pnpm server      # self-hosted issuer
//   WORLD_ID_ISSUER=https://world-id.issuer.example pnpm server  # shared issuer
import * as http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import * as World from 'mppx/extensions/identity/world'
import * as Identity from 'mppx/identity'
import { Mppx, Request, Store, tempo } from 'mppx/server'
import { createClient, http as transport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

const PORT = Number(process.env.PORT ?? 4021)
const ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`
const FREE_USES = 1

// Set MPP_SECRET_KEY so Challenges stay valid across restarts and instances.
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

// Self-hosted: this app is the issuer for its own origin. Register a confidential client at
// https://auth.world.org/portal. The signing key is per process here; persist one in production
// so attestations survive restarts.
const issuer = process.env.WORLD_CLIENT_ID
  ? World.Issuer.create({
      audiences: [ORIGIN],
      clientId: process.env.WORLD_CLIENT_ID,
      clientSecret: process.env.WORLD_CLIENT_SECRET!,
      // One attempt start per minute per client IP. Trust x-forwarded-for only behind your proxy.
      limit: {
        key: (request) => request.headers.get('x-forwarded-for') ?? 'local',
        max: 1,
        window: 60,
      },
      secretKey,
      signingKey: (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
      ])) as CryptoKeyPair,
      store,
      url: ORIGIN,
      worldIssuer: process.env.WORLD_ISSUER ?? World.Constants.worldIssuer,
    })
  : undefined

const human = World.Server.verifier({
  acr: [World.Constants.acr.orb, World.Constants.acr.orbFace],
  audience: ORIGIN,
  issuer: issuer?.url ?? process.env.WORLD_ID_ISSUER!,
  // Self-hosted, the key resolves in process instead of from the JWKS route.
  keyResolver: issuer?.keyResolver,
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
  // The issuer's routes (device, token, JWKS) when self-hosted.
  const answered = await issuer?.handle(request)
  if (answered) return answered
  const url = new URL(request.url)
  if (url.pathname !== '/api/report') return new Response('Not found', { status: 404 })

  // Without an attestation: 401 with Identity-Attestation-Required, and the client gets one from
  // the issuer.
  const identity = await human.verify(request)
  if (identity.status !== 'valid')
    return new Response(identity.reason, {
      status: Identity.Status.codes[identity.status],
      headers: identity.headers,
    })
  const { issuer: attestedBy, subject } = identity.value
  const report = 'Q3 cross-border volume: $41.2M (+18%)'
  if (await useFreeReport(`${attestedBy} ${subject}`)) return Response.json({ report, paid: false })

  const result = await mppx.charge({ amount: '0.01', description: 'Market report' })(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ report, paid: true }))
}

http
  .createServer(Request.toNodeListener(handle))
  .listen(PORT, () => console.log(`Listening on ${ORIGIN}`))
