import { serve } from '@hono/node-server'
import { paymentRequired } from '@mpp/hono'
import { Hono } from 'hono'
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

const app = new Hono()

app.get(
  '/api/chat',
  paymentRequired(mpay.stream({ amount: '0.000075', unitType: 'token' })),
  (c) => {
    const tokens = generateTokens()
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
      async start(controller) {
        for (const token of tokens) {
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
  },
)

function generateTokens(): string[] {
  return ['The', ' answer', ' to', ' your', ' question', ' is', ' 42.']
}

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

serve({ fetch: app.fetch, port: 3000 })
console.log('Hono streaming server running on http://localhost:3000')
