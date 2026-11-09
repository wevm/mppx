// Identity Fortune: a paid haiku API on Cloudflare Workers that gets cheaper and more
// personal the more the caller proves about themselves.
//
//   GET /api/fortune              anyone: 402 at the anonymous price, or a better tier when
//                                 the request already carries proofs (an attestation, an API key)
//   GET /api/fortune?tier=email   requires a verified email: 401 Identity-Attestation-Required
//                                 until the client presents one, then 402 at the email price
//   GET /api/fortune?tier=member  requires a member API key or a verified @tempo.xyz email
//
// The email issuer (the "email worker") runs under /issuer in this same Worker.
import { Receipt } from 'mppx'
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

import * as Fortune from './fortune.js'
import * as Issuer from './issuer.js'
import * as Tiers from './tiers.js'
import * as Trace from './trace.js'

// The Durable Object class that stores spent credentials and pending codes, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

type Env = Issuer.Env &
  Fortune.Env & {
    /** Durable Object namespace of {@link MppxStore}. */
    MPPX_STORE: Store.durableObject.Namespace
    /** Payee account key: receives payments and pays gas as the fee payer. */
    MPP_PRIVATE_KEY: string
    /** Secret that binds challenge IDs. */
    MPP_SECRET_KEY: string
    /** This deployment's public origin, when the request URL is not it (behind a proxy). */
    PUBLIC_ORIGIN?: string | undefined
    /** Local development behind a proxy only: take the origin from X-Forwarded-Host. */
    TRUST_FORWARDED_HOST?: string | undefined
    /** Optional Tempo RPC URL. Defaults to the public testnet RPC. */
    TEMPO_RPC_URL?: string | undefined
  }

const apps = new Map<string, ReturnType<typeof createApp>>()
function createApp(env: Env, origin: string) {
  console.log(`Serving ${origin}`)
  const issuer = `${origin}${Issuer.path}`
  const store = Store.durableObject(env.MPPX_STORE)
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  const mppx = Mppx.create({
    secretKey: env.MPP_SECRET_KEY,
    methods: [
      tempo({
        account,
        chainId: Chain.testnet.id,
        currency: '0x20c0000000000000000000000000000000000000', // pathUSD
        feePayer: true,
        getClient: () => client,
        recipient: account.address,
        store,
      }),
    ],
  })
  const tiers = Tiers.create({ audience: origin, env, issuer })
  return { issuer, mppx, store: store as unknown as Issuer.Store, tiers }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = publicOrigin(request, env)
    const app = apps.get(origin) ?? createApp(env, origin)
    apps.set(origin, app)
    const trace = Trace.create()

    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

    if (url.pathname === '/api/config')
      return Response.json({ issuer: app.issuer, origin, prices: Tiers.prices })

    // The demo inbox: the message the issuer would have emailed, while the code is pending.
    if (url.pathname.startsWith('/api/inbox/')) {
      const message = await Issuer.inbox(app.store, url.pathname.slice('/api/inbox/'.length))
      return message
        ? Response.json(message)
        : Response.json({ error: 'No message.' }, { status: 404 })
    }

    if (url.pathname.startsWith(`${Issuer.path}/`)) {
      const response = await Issuer.handle(request, {
        env,
        issuer: app.issuer,
        store: app.store,
        trace,
      })
      return trace.attach(response ?? Response.json({ error: 'Not found.' }, { status: 404 }))
    }

    if (url.pathname === '/api/fortune')
      return trace.attach(await fortune(request, { app, env, trace }))

    return new Response('Not found', { status: 404 })
  },
}

async function fortune(
  request: Request,
  parameters: { app: ReturnType<typeof createApp>; env: Env; trace: Trace.Trace },
): Promise<Response> {
  const { app, env, trace } = parameters
  const { mppx, tiers } = app
  const url = new URL(request.url)
  const paid = request.headers.has('Authorization')
  // step: request
  trace.step(
    'request',
    `${request.method} ${url.pathname}${url.search}${paid ? ' with payment' : ''}`,
  )

  // The tier the caller asked for, or the best one their proofs already reach.
  // step: tier
  const proven = await tiers.resolve(request, trace)
  const asked = Tiers.parse(url.searchParams.get('tier'))
  const tier = asked && Tiers.above(asked, proven) ? asked : proven
  trace.step('tier', `${tier} at ${Tiers.prices[tier]} pathUSD`)

  // step: charge
  const verifier = tiers.verifiers[tier]
  const result = await mppx.charge({
    amount: Tiers.prices[tier],
    description: `A ${tier} fortune`,
    ...(verifier && { identity: [verifier] }),
  })(request)

  // step: identity.required
  if (result.status === 402 && result.rejection) {
    trace.step('identity.required', `${result.rejection.status}: ${result.rejection.reason}`)
    return result.challenge
  }
  // step: charge.challenge
  if (result.status === 402) {
    trace.step('charge.challenge', `402: pay ${Tiers.prices[tier]} pathUSD`)
    const challenge = new Response(result.challenge.body, result.challenge)
    // Tells callers what proving more would get them.
    const upgrades = Object.entries(Tiers.prices)
      .filter(([name]) => Tiers.above(name as Tiers.Tier, tier))
      .map(([name, price]) => name + ';price="' + price + '"')
    if (upgrades.length > 0) challenge.headers.set('Fortune-Upgrades', upgrades.join(', '))
    return challenge
  }

  // step: fortune
  const profile = tiers.profile(result.identity)
  const haiku = await Fortune.write(profile, { env, trace })

  // step: charge.settled
  const response = result.withReceipt(
    Response.json({
      tier,
      price: Tiers.prices[tier],
      haiku: haiku.lines,
      model: haiku.model,
      prompt: haiku.prompt,
      seen: profile.seen,
      profile,
    }),
  )
  const receipt = Receipt.fromResponse(response)
  trace.step('charge.settled', `${receipt.status}: ${receipt.reference}`)
  return response
}

/** The origin attestations are bound to: this deployment's public origin. */
function publicOrigin(request: Request, env: Env): string {
  if (env.PUBLIC_ORIGIN) return new URL(env.PUBLIC_ORIGIN).origin
  const host = env.TRUST_FORWARDED_HOST === 'true' && request.headers.get('X-Forwarded-Host')
  if (host)
    return `${request.headers.get('X-Forwarded-Proto') ?? new URL(request.url).protocol.slice(0, -1)}://${host.split(',')[0]!.trim()}`
  return new URL(request.url).origin
}
