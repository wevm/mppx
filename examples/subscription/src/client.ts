import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import type { Subscription } from 'mppx/tempo'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'

const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173'
const userId = process.env.USER_ID ?? 'user-1'
const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

const client = createClient({
  account,
  chain: tempoModerato,
  transport: http(process.env.MPPX_RPC_URL),
})

const mppx = Mppx.create({
  methods: [
    tempo.subscription({
      account,
      getClient: async () => client,
      validateRequest: (request) => {
        if (BigInt(request.amount) > 1n) throw new Error('subscription amount too high')
      },
    }),
  ],
  polyfill: false,
})

async function readArticle(label: string) {
  const response = await mppx.fetch(`${baseUrl}/api/article`, {
    headers: { 'X-User-Id': userId },
  })
  if (!response.ok) throw new Error(`article request failed: ${response.status}`)

  const receipt = Receipt.fromResponse(response)
  const body = (await response.json()) as { article: string; plan: string }
  console.log(label)
  console.log(body.article)
  console.log(`subscriptionId=${receipt.subscriptionId}`)
  console.log(`reference=${receipt.reference}`)
}

console.log(`Payer: ${account.address}`)

await readArticle('Initial activation')

console.log('Run the server with an overdue stored subscription to exercise renewal.')

await readArticle('Reused access')

const subscriptionResponse = await fetch(`${baseUrl}/api/subscription?userId=${userId}`)
const subscription = (await subscriptionResponse.json()) as Subscription.SubscriptionRecord
console.log(`lastChargedPeriod=${subscription.lastChargedPeriod}`)
