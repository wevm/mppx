import { paymentRequired } from '@mpp/express'
import express from 'express'
import { Mpay, tempo } from 'mpay/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createMemoryStorage } from './storage.js'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000001' as const

const storage = createMemoryStorage()

const mpay = Mpay.create({
  methods: [
    tempo.charge({ currency, feePayer: account, recipient: account.address, testnet: true }),
    tempo.stream({ currency, recipient: account.address, storage }),
  ],
  realm: 'localhost',
  secretKey: process.env.SECRET_KEY ?? 'example-secret',
})

const app = express()

app.get('/api/fortune', paymentRequired(mpay.charge({ amount: '1' })), (_req, res) => {
  res.json({ fortune: 'A golden egg of opportunity falls into your lap this month.' })
})

app.get('/api/chat', async (req, res) => {
  const result = await Mpay.toNodeListener(
    mpay.stream({ amount: '0.000075', unitType: 'token' }),
  )(req, res)
  if (result.status === 402) return

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')

  for (const token of ['The', ' answer', ' is', ' 42.']) {
    res.write(`data: ${JSON.stringify({ token })}\n\n`)
    await new Promise((r) => setTimeout(r, 50))
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

app.listen(3000, () => console.log('Express server running on http://localhost:3000'))
