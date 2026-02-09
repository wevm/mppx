import express from 'express'
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

const app = express()

app.get('/api/fortune', async (req, res) => {
  const result = await Mpay.toNodeListener(mpay.charge({ amount: '1' }))(req, res)
  if (result.status === 402) return
  res.json({ fortune: 'A golden egg of opportunity falls into your lap this month.' })
})

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

app.listen(3000, () => console.log('Express server running on http://localhost:3000'))
