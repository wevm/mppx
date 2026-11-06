// News app subscriber — Example
//
// 1. The first request to /api/article gets a 402 with a server access key.
// 2. The client signs a `keyAuthorization` scoped to that key; the server
//    charges the first period and activates the subscription.
// 3. The next request signs a fresh credential and reuses the active
//    subscription without another charge.
//
//   pnpm client                              # against pnpm dev
//   BASE_URL=https://<worker>.workers.dev pnpm client
import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import type { Subscription } from 'mppx/tempo'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const baseUrl = process.env.BASE_URL ?? 'http://localhost:8787'
const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

const client = createClient({
  account,
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(process.env.MPPX_RPC_URL),
})

console.log(`Payer: ${account.address}`)
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const mppx = Mppx.create({
  methods: [
    tempo.subscription({
      account,
      getClient: async () => client,
      validateRequest: (request) => {
        // Refuse more than 1 pathUSD (6 decimals) per period.
        if (BigInt(request.amount) > 1_000_000n) throw new Error('subscription amount too high')
      },
    }),
  ],
  polyfill: false,
})

async function readArticle(label: string) {
  const response = await mppx.fetch(`${baseUrl}/api/article`)
  if (!response.ok) throw new Error(`article request failed: ${response.status}`)

  const receipt = Receipt.fromResponse(response)
  const body = (await response.json()) as { article: string; plan: string }
  console.log(label)
  console.log(body.article)
  console.log(`subscriptionId=${receipt.subscriptionId}`)
  console.log(`reference=${receipt.reference}`)
}

await readArticle('Initial activation')

console.log('Run the server with an overdue stored subscription to exercise renewal.')

await readArticle('Reused access')

const subscriptionResponse = await mppx.fetch(`${baseUrl}/api/subscription`)
const subscription = (await subscriptionResponse.json()) as Subscription.SubscriptionRecord
console.log(`lastChargedPeriod=${subscription.lastChargedPeriod}`)
