import express from 'express'
import { Mpay, tempo } from 'mpay/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createMemoryStorage } from './storage.js'

const account = privateKeyToAccount(generatePrivateKey())

const storage = createMemoryStorage()

const mpay = Mpay.create({
  methods: [
    tempo.stream({
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: account.address,
      storage,
    }),
  ],
  realm: 'localhost',
  secretKey: process.env.SECRET_KEY ?? 'example-secret',
})

const app = express()

app.get('/api/chat', async (req, res) => {
  const result = await Mpay.toNodeListener(mpay.stream({ amount: '0.000075', unitType: 'token' }))(
    req,
    res,
  )
  if (result.status === 402) return

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')

  for (const token of generateTokens()) {
    res.write(`data: ${JSON.stringify({ token })}\n\n`)
    await new Promise((r) => setTimeout(r, 50))
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

function generateTokens(): string[] {
  return ['The', ' answer', ' to', ' your', ' question', ' is', ' 42.']
}

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

app.listen(3000, () => console.log('Express streaming server running on http://localhost:3000'))
