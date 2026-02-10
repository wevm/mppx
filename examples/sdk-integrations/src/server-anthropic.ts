/**
 * Server: Charge per-token for Anthropic Claude streaming responses.
 *
 * Shows how an API provider wraps Anthropic's SDK with mpay to charge
 * callers per LLM token via the 402 Payment flow + SSE streaming.
 */
import Anthropic from '@anthropic-ai/sdk'
import { Mpay, tempo } from 'mpay/server'
import { createMemoryStorage } from './storage.js'

const anthropic = new Anthropic()

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

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          const data = JSON.stringify({ token: event.delta.text })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
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
