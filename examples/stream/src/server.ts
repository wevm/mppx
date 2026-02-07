import { Mpay, tempo } from 'mpay/server'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'
import { createMemoryStorage } from './storage.js'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000001' as const
const pricePerToken = '0.000075'

const storage = createMemoryStorage()

const mpay = Mpay.create({
  methods: [
    tempo.stream({
      currency,
      recipient: account.address,
      storage,
    }),
  ],
  realm: 'localhost',
  // Example-only. In production, use a strong random secret from env.
  secretKey: process.env.SECRET_KEY ?? 'stream-example-secret',
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/api/chat') {
    const prompt = url.searchParams.get('prompt') ?? 'Hello!'

    const result = await mpay.stream({
      amount: pricePerToken,
      unitType: 'token',
    })(request)

    if (result.status === 402) return result.challenge as globalThis.Response

    const tokens = generateTokens(prompt)
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
      async start(controller) {
        for (const token of tokens) {
          const data = JSON.stringify({ token })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          await new Promise((r) => setTimeout(r, 50))
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

  return null
}

function generateTokens(_prompt: string): string[] {
  return [
    'The',
    ' answer',
    ' to',
    ' your',
    ' question',
    ' is',
    ' 42.',
    ' That',
    "'s",
    ' always',
    ' the',
    ' answer.',
  ]
}

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

console.log(`Server recipient: ${account.address}`)
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
console.log('Server account funded')
