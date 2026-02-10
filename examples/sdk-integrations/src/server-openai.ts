/**
 * Server: Charge per-token for OpenAI-style streaming responses.
 *
 * Shows how an API provider wraps OpenAI's SDK with mpay to charge
 * callers per LLM token via the 402 Payment flow + SSE streaming.
 */
import OpenAI from 'openai'
import { Mpay, tempo } from 'mpay/server'
import { createMemoryStorage } from './storage.js'

const openai = new OpenAI()

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

  // 1. Require payment — returns 402 challenge if no credential
  const result = await mpay.stream({
    amount: '0.0001',
    unitType: 'token',
  })(request)

  if (result.status === 402) return result.challenge as Response

  // 2. Stream from OpenAI, relay as SSE to the caller
  const stream = await openai.responses.create({
    model: 'gpt-5.2',
    input: prompt,
    stream: true,
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          const data = JSON.stringify({ token: event.delta })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  // 3. Attach payment receipt to the streaming response
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
