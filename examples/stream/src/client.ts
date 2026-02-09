import { Mpay, tempo } from 'mpay/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const currency = '0x20c0000000000000000000000000000000000001' as const

const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

console.log(`Client account: ${account.address}`)
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const balance = await Actions.token.getBalance(client, { account, token: currency })
console.log(`Balance: ${Number(balance) / 1e6} alphaUSD`)

const mpay = Mpay.create({
  polyfill: false,
  methods: [
    tempo({
      account,
      deposit: '10',
    }),
  ],
})

const prompt = process.argv[2] ?? 'Tell me something interesting'
console.log(`\nPrompt: ${prompt}`)

const response = await mpay.fetch(`${BASE_URL}/api/chat?prompt=${encodeURIComponent(prompt)}`)

if (!response.ok) {
  console.error(`Error: ${response.status}`)
  console.error(await response.text())
  process.exit(1)
}

const receipt = response.headers.get('Payment-Receipt')
if (receipt) console.log(`Payment-Receipt: ${receipt.slice(0, 40)}...`)

const reader = response.body?.getReader()
if (!reader) {
  console.log('No response body')
  process.exit(1)
}

const decoder = new TextDecoder()

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  const chunk = decoder.decode(value, { stream: true })
  const lines = chunk.split('\n')

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6).trim()
    if (data === '[DONE]') continue

    try {
      const { token } = JSON.parse(data) as { token: string }
      process.stdout.write(token)
    } catch {}
  }
}

console.log('\n\nStream complete.')
