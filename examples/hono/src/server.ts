import { serve } from '@hono/node-server'
import { paymentRequired } from '@mpp/hono'
import { Hono } from 'hono'
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

const app = new Hono()

app.get('/api/fortune', paymentRequired(mpay.charge({ amount: '1' })), (c) => {
  return c.get('withReceipt')(
    c.json({ fortune: 'A golden egg of opportunity falls into your lap this month.' }),
  )
})

app.get('/api/chat', paymentRequired(mpay.stream({ amount: '0.000075', unitType: 'token' })), (c) => {
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for (const token of ['The', ' answer', ' is', ' 42.']) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token })}\n\n`))
        await new Promise((r) => setTimeout(r, 50))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return c.get('withReceipt')(
    new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }),
  )
})

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

serve({ fetch: app.fetch, port: 3000 })
console.log('Hono server running on http://localhost:3000')
