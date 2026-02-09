import { serve } from '@hono/node-server'
import { paymentRequired } from '@mpp/hono'
import { Hono } from 'hono'
import { Mpay, tempo } from 'mpay/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(generatePrivateKey())

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001',
      feePayer: account,
      recipient: account.address,
      testnet: true,
    }),
  ],
})

const app = new Hono()

app.get('/api/fortune', paymentRequired(mpay.charge({ amount: '1' })), (c) => {
  return c.get('withReceipt')(
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
