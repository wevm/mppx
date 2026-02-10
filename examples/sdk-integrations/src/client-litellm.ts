/**
 * Client: Pay for LiteLLM proxy calls using mpay.
 *
 * LiteLLM (35.6k GitHub stars) is the dominant Python-side LLM gateway.
 * It exposes an OpenAI-compatible API, so the TS client uses the OpenAI
 * SDK pointed at the LiteLLM proxy — mpay handles payment transparently.
 *
 * This is the pattern for any OpenAI-compatible proxy:
 * - LiteLLM
 * - Together AI
 * - Fireworks AI
 * - Ollama
 * - vLLM
 * - Any custom proxy
 */
import OpenAI from 'openai'
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

Mpay.create({
  methods: [tempo({ account })],
})

// Point at any OpenAI-compatible proxy with 402 payment support
const litellm = new OpenAI({
  baseURL: 'https://litellm-proxy.example.com',
  apiKey: 'not-needed',
})

// LiteLLM routes to any backend (Anthropic, Gemini, Bedrock, etc.)
const stream = await litellm.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'Explain payment channels.' }],
  stream: true,
})

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content
  if (content) process.stdout.write(content)
}

// Together AI — same pattern, different baseURL
const together = new OpenAI({
  baseURL: 'https://api.together.xyz/v1',
  apiKey: process.env.TOGETHER_API_KEY,
})

const togetherStream = await together.chat.completions.create({
  model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
})

for await (const chunk of togetherStream) {
  const content = chunk.choices[0]?.delta?.content
  if (content) process.stdout.write(content)
}
