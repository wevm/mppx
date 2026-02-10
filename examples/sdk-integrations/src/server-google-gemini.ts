/**
 * Server: Charge per-token for Google Gemini streaming responses.
 *
 * Google's Gemini SDK uses `generateContentStream()` which returns
 * an async iterable of chunks — same SSE pattern as everyone else.
 */
import { GoogleGenAI } from '@google/genai'
import { Mpay, tempo } from 'mpay/server'
import { createMemoryStorage } from './storage.js'

const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! })

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

  const response = await genai.models.generateContentStream({
    model: 'gemini-2.5-flash',
    contents: prompt,
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of response) {
        const text = chunk.text
        if (text) {
          const data = JSON.stringify({ token: text })
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
