/**
 * Client: Pay for an Anthropic-compatible API using mpay.
 *
 * Same fetch polyfill pattern — Anthropic's SDK uses httpx/fetch
 * internally, so mpay intercepts 402 responses automatically.
 */
import Anthropic from '@anthropic-ai/sdk'
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

Mpay.create({
  methods: [tempo({ account })],
})

const anthropic = new Anthropic({
  baseURL: 'https://paid-api.example.com',
  apiKey: 'not-needed-payment-is-onchain',
})

const stream = anthropic.messages.stream({
  model: 'claude-sonnet-4-5-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'What is the 402 status code?' }],
})

for await (const event of stream) {
  if (
    event.type === 'content_block_delta' &&
    event.delta.type === 'text_delta'
  ) {
    process.stdout.write(event.delta.text)
  }
}
