# SDK Integrations

Shows how mpay composes with every major LLM/AI SDK in TypeScript.

## Key Insight

**mpay works with every SDK out of the box** because it operates at the `fetch` layer. Since all LLM SDKs use `fetch` (or HTTP) internally, mpay's fetch polyfill transparently handles 402 Payment Required flows without any SDK-specific integration code.

## Client-Side (Paying for AI APIs)

How a **consumer** pays for AI API calls using mpay:

| Example | SDK | Pattern |
|---------|-----|---------|
| [client-openai.ts](./src/client-openai.ts) | OpenAI SDK (12.2M npm/week) | Fetch polyfill — zero code changes |
| [client-anthropic.ts](./src/client-anthropic.ts) | Anthropic SDK | Fetch polyfill — zero code changes |
| [client-vercel-ai.ts](./src/client-vercel-ai.ts) | Vercel AI SDK (20.8k stars) | Inject `mpay.fetch` into provider |
| [client-openrouter.ts](./src/client-openrouter.ts) | OpenRouter SDK (387k npm/week) | Fetch polyfill via OpenAI SDK |
| [client-litellm.ts](./src/client-litellm.ts) | LiteLLM / Together / Fireworks | OpenAI SDK + different `baseURL` |
| [client-google-gemini.ts](./src/client-google-gemini.ts) | Google GenAI SDK | Fetch polyfill — zero code changes |

### How it works (client)

```ts
import { Mpay, tempo } from 'mpay/client'

// 1. Polyfill fetch — every SDK gains 402 payment handling
Mpay.create({ methods: [tempo({ account })] })

// 2. Use any SDK normally — mpay handles payment transparently
const stream = await openai.responses.create({ model: 'gpt-5.2', input: '...', stream: true })
```

## Server-Side (Charging for LLM Streaming)

How an **API provider** charges per-token for LLM responses using mpay:

| Example | SDK | Streaming Pattern |
|---------|-----|-------------------|
| [server-openai.ts](./src/server-openai.ts) | OpenAI SDK | `for await (event of stream)` → SSE |
| [server-anthropic.ts](./src/server-anthropic.ts) | Anthropic SDK | `messages.stream()` → SSE |
| [server-vercel-ai.ts](./src/server-vercel-ai.ts) | Vercel AI SDK | `streamText().textStream` → SSE |
| [server-google-gemini.ts](./src/server-google-gemini.ts) | Google GenAI SDK | `generateContentStream()` → SSE |
| [server-cohere.ts](./src/server-cohere.ts) | Cohere SDK | `chatStream()` → SSE |

### How it works (server)

```ts
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({ methods: [tempo.stream({ ... })] })

export async function handler(request: Request) {
  // 1. Require payment
  const result = await mpay.stream({ amount: '0.0001', unitType: 'token' })(request)
  if (result.status === 402) return result.challenge

  // 2. Stream from any LLM SDK
  const stream = await openai.responses.create({ model: 'gpt-5.2', input: '...', stream: true })

  // 3. Relay as SSE with payment receipt
  return result.withReceipt(new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } }))
}
```

## Transport: SSE Everywhere

Every major LLM provider uses **Server-Sent Events (SSE)** for streaming. This is significant for mpay because:

1. SSE is unidirectional (server → client), built on HTTP — fits the 402 flow naturally
2. The `stream: true` flag is universal across all SDKs
3. All SDKs expose async iterables (`for await...of`) for consuming streams
4. Payment credentials are sent via HTTP headers, which SSE inherits from the initial request

WebSocket is only used by OpenAI's Realtime (voice) API — not relevant for text/token streaming.

## SDK Landscape Summary

| Tier | SDKs | mpay Integration |
|------|------|------------------|
| **Provider-native** | OpenAI, Anthropic, Google, Mistral, Cohere | Fetch polyfill (zero changes) |
| **Abstraction layers** | Vercel AI SDK, LangChain | Inject `mpay.fetch` or polyfill |
| **Routers/gateways** | OpenRouter, LiteLLM | OpenAI SDK + `baseURL` swap |
| **OpenAI-compatible** | Together, Fireworks, Ollama, vLLM | OpenAI SDK + `baseURL` swap |
