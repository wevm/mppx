/**
 * Client: Pay for an OpenAI-compatible API using mpay.
 *
 * The OpenAI SDK is the de facto standard (12.2M npm weekly downloads).
 * Most providers (OpenRouter, Together, Fireworks, LiteLLM) are
 * OpenAI-compatible, so this pattern covers ~80% of use cases.
 *
 * mpay.fetch polyfills globalThis.fetch, so the OpenAI SDK's internal
 * fetch calls automatically handle 402 Payment Required responses.
 */
import OpenAI from 'openai'
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

// 1. mpay polyfills globalThis.fetch — all HTTP requests gain 402 handling
Mpay.create({
  methods: [tempo({ account })],
})

// 2. Point OpenAI SDK at a paid API (no code changes needed)
const openai = new OpenAI({
  baseURL: 'https://paid-api.example.com/v1',
  apiKey: 'not-needed-payment-is-onchain',
})

// 3. Use the SDK normally — mpay handles payment transparently
const stream = await openai.responses.create({
  model: 'gpt-5.2',
  input: 'Explain how HTTP 402 payment works.',
  stream: true,
})

for await (const event of stream) {
  if (event.type === 'response.output_text.delta') {
    process.stdout.write(event.delta)
  }
}
