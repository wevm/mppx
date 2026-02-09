import { PaidRoute } from '@mpp/nextjs'
import { Mpay, tempo } from 'mpay/server'
import { privateKeyToAccount } from 'viem/accounts'
import { createMemoryStorage } from '../../../../storage.js'

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)

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

export const GET = PaidRoute(
  mpay.stream({ amount: '0.000075', unitType: 'token' }),
  async (_request, { withReceipt }) => {
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

    return withReceipt(
      new Response(readable, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      }),
    )
  },
)
