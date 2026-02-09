import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Mpay, tempo } from 'mpay/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000001' as const

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      currency,
      feePayer: account,
      recipient: account.address,
      testnet: true,
    }),
  ],
})

const app = new Hono()

app.get('/api/fortune', async (c) => {
  const result = await mpay.charge({ amount: '1' })(c.req.raw)
  if (result.status === 402) return result.challenge
  return result.withReceipt(
    c.json({ fortune: 'A golden egg of opportunity falls into your lap this month.' }),
  )
})

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

serve({ fetch: app.fetch, port: 3000 })
console.log('Hono server running on http://localhost:3000')
