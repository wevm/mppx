/**
 * Client: Pay for OpenRouter API calls using mpay.
 *
 * OpenRouter (387k npm weekly downloads) provides access to 300+ models
 * through a unified API. It supports both its own SDK and the OpenAI SDK
 * (via baseURL swap). Both patterns work with mpay.
 */
import OpenAI from 'openai'
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

// Pattern 1: OpenRouter via OpenAI SDK (most common)
// ───────────────────────────────────────────────────
Mpay.create({
  methods: [tempo({ account })],
})

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://myapp.example.com',
    'X-Title': 'My App',
  },
})

const stream = await openrouter.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'What is HTTP 402?' }],
  stream: true,
})

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content
  if (content) process.stdout.write(content)
}

// Pattern 2: OpenRouter's own SDK
// ────────────────────────────────
// import { OpenRouter } from '@openrouter/sdk'
//
// The @openrouter/sdk uses fetch internally, so mpay.fetch polyfill
// works here too. Streaming via getTextStream():
//
// const result = openRouter.callModel({
//   model: 'openai/gpt-5.2',
//   input: 'Hello!',
// })
//
// for await (const delta of result.getTextStream()) {
//   process.stdout.write(delta)
// }
