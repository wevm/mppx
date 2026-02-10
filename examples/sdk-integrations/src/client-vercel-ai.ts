/**
 * Client: Pay for AI APIs using Vercel AI SDK + mpay.
 *
 * The Vercel AI SDK (20.8k stars) is the dominant abstraction layer
 * for LLM streaming in Next.js/React apps. It supports 25+ providers
 * and single-line model switching.
 *
 * mpay.fetch wraps the underlying fetch, so `streamText()` and
 * `generateText()` automatically handle 402 payment flows.
 */
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

const mpay = Mpay.create({
  methods: [tempo({ account })],
  polyfill: false,
})

// Point any Vercel AI SDK provider at a paid endpoint
const paidProvider = createOpenAI({
  baseURL: 'https://paid-api.example.com/v1',
  apiKey: 'not-needed',
  fetch: mpay.fetch, // <-- inject mpay's payment-aware fetch
})

const result = streamText({
  model: paidProvider('gpt-5.2'),
  prompt: 'Explain machine payments in one paragraph.',
})

for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}
