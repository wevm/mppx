import { Mppx, tempo } from 'mppx/client'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const XQUIK_BASE = 'https://xquik.com/api/v1'

// Create a funded testnet account
const account = privateKeyToAccount(
  (process.env.TEMPO_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey(),
)

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

console.log('Funding testnet account...')
await Actions.faucet.fundSync(client, { account })
console.log(`Account: ${account.address}\n`)

// Initialize MPP — patches global fetch to auto-handle 402 challenges
const mppx = Mppx.create({
  methods: [tempo({ account })],
})

// 1. Tweet lookup (charge: $0.0003/call)
console.log('--- Tweet Lookup (charge) ---')
const tweetRes = await mppx.fetch(`${XQUIK_BASE}/x/tweets/1893456789012345678`)
if (tweetRes.ok) {
  const data = (await tweetRes.json()) as { tweet: { text: string; likeCount: number } }
  console.log(`Tweet: ${data.tweet.text}`)
  console.log(`Likes: ${data.tweet.likeCount}\n`)
} else {
  console.log(`Tweet lookup failed: ${tweetRes.status}\n`)
}

// 2. User lookup (charge: $0.00036/call)
console.log('--- User Lookup (charge) ---')
const userRes = await mppx.fetch(`${XQUIK_BASE}/x/users/xquikcom`)
if (userRes.ok) {
  const user = (await userRes.json()) as { username: string; name: string; followers: number }
  console.log(`User: @${user.username} (${user.name})`)
  console.log(`Followers: ${user.followers}\n`)
} else {
  console.log(`User lookup failed: ${userRes.status}\n`)
}

// 3. Tweet search (session: $0.0003/tweet)
console.log('--- Tweet Search (session) ---')
const searchRes = await mppx.fetch(
  `${XQUIK_BASE}/x/tweets/search?${new URLSearchParams({ q: 'AI agents', limit: '3' })}`,
)
if (searchRes.ok) {
  const data = (await searchRes.json()) as { tweets: Array<{ text: string }>; total: number }
  console.log(`Found ${data.total} tweets:`)
  for (const tweet of data.tweets) {
    console.log(`  - ${tweet.text.slice(0, 80)}...`)
  }
} else {
  console.log(`Search failed: ${searchRes.status}`)
}
