/**
 * Client: Pay for Google Gemini API calls using mpay.
 *
 * Google's GenAI SDK uses fetch internally. mpay's fetch polyfill
 * intercepts 402 responses from paid Gemini-compatible endpoints.
 */
import { GoogleGenAI } from '@google/genai'
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

Mpay.create({
  methods: [tempo({ account })],
})

const genai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY!,
})

const response = await genai.models.generateContentStream({
  model: 'gemini-2.5-flash',
  contents: 'What are machine-to-machine payments?',
})

for await (const chunk of response) {
  const text = chunk.text
  if (text) process.stdout.write(text)
}
