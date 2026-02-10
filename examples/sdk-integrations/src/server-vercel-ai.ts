/**
 * Server: Charge per-token using Vercel AI SDK's `streamText`.
 *
 * The Vercel AI SDK is the most popular abstraction layer for LLM streaming
 * in Next.js/React apps (20.8k GitHub stars, 25+ providers). This shows
 * how mpay composes with `streamText()` and provider-switching.
 */
import { streamText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { Mpay, tempo } from 'mpay/server'
import { createMemoryStorage } from './storage.js'

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
  const { prompt, provider = 'openai' } = await request.json()

  const result = await mpay.stream({
    amount: '0.0001',
    unitType: 'token',
  })(request)

  if (result.status === 402) return result.challenge as Response

  // Vercel AI SDK: swap providers with one line
  const model =
    provider === 'anthropic'
      ? anthropic('claude-sonnet-4-5-20250514')
      : provider === 'google'
        ? google('gemini-2.5-flash')
        : openai('gpt-5.2')

  const aiStream = streamText({
    model,
    prompt,
  })

  // streamText returns a Response-compatible stream
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of aiStream.textStream) {
        const data = JSON.stringify({ token: chunk })
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
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
