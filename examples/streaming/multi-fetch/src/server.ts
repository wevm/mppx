import { Mpay, tempo } from 'mpay/server'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000000' as const

const storage = tempo.memoryStorage()

const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

const mpay = Mpay.create({
  methods: [
    tempo.stream({
      currency,
      // getClient: () => client,
      recipient: account.address,
      storage,
      testnet: true,
    }),
  ],
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/api/scrape') {
    const pageUrl = url.searchParams.get('url') ?? 'https://example.com'

    const result = await mpay.stream({
      amount: '0.002',
      unitType: 'page', // remove 
    })(request)

    if (result.status === 402) return result.challenge as globalThis.Response

    const content = scrapePage(pageUrl)

    return result.withReceipt(Response.json({ content, url: pageUrl }))
  }

  return null
}

function scrapePage(url: string): string {
  return `<h1>${url}</h1><p>Scraped content from ${url}</p>`
}

console.log(`Server recipient: ${account.address}`)
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
console.log('Server account funded')
