import { Fetch, tempo } from 'mpay/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const account = privateKeyToAccount(generatePrivateKey())

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

const paidFetch = Fetch.from({
  methods: [tempo.stream({ account, deposit: 10_000_000n })],
})

const response = await paidFetch('http://localhost:3000/api/chat')
const reader = response.body?.getReader()
if (!reader) process.exit(1)

const decoder = new TextDecoder()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const chunk = decoder.decode(value, { stream: true })
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6).trim()
    if (data === '[DONE]') continue
    try {
      const { token } = JSON.parse(data) as { token: string }
      process.stdout.write(token)
    } catch {}
  }
}
console.log('\n')
