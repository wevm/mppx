/**
 * Server: Charge per-token for Cohere streaming responses.
 *
 * Cohere's SDK uses `chatStream()` which returns an event-based
 * async iterable with `content-delta` events for token chunks.
 */
import { CohereClientV2 } from 'cohere-ai'
import { Mpay, tempo } from 'mpay/server'
import { createMemoryStorage } from './storage.js'

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY! })

const mpay = Mpay.create({
  methods: [
    tempo.stream({
      currency: '0x20c0000000000000000000000000000000000001',
      getClient: () => client,
      recipient: account.address,
      storage: createMemoryStorage(),
    }),
  ],
})

export async function handler(request: Request): Promise<Response> {
  const { prompt } = await request.json()

  const result = await mpay.stream({
    amount: '0.0001',
    unitType: 'token',
  })(request)

  if (result.status === 402) return result.challenge as Response

  const stream = await cohere.chatStream({
    model: 'command-a-03-2025',
    messages: [{ role: 'user', content: prompt }],
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        if (event.type === 'content-delta') {
          const text = event.delta?.message?.content?.text
          if (text) {
            const data = JSON.stringify({ token: text })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return result.withReceipt(
    new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }),
  )
}
