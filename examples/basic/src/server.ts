import { Mppx, tempo } from 'mppx/server'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000001' as const // alphaUSD

const mppx = Mppx.create({
  methods: [
    tempo({
      currency,
      feePayer: true,
      recipient: account.address,
      testnet: true,
    }),
  ],
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Free
  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  // Paid
  if (url.pathname === '/api/fortune') {
    const result = await mppx.charge({ amount: '1' })(request)

    if (result.status === 402) return result.challenge

    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]!

    return result.withReceipt(Response.json({ fortune }))
  }

  return null
}

const fortunes = [
  'A beautiful, smart, and loving person will come into your life.',
  'A dubious friend may be an enemy in camouflage.',
  'A faithful friend is a strong defense.',
  'A fresh start will put you on your way.',
  'A golden egg of opportunity falls into your lap this month.',
  'A good time to finish up old tasks.',
  'A hunch is creativity trying to tell you something.',
  'A lifetime of happiness lies ahead of you.',
  'A light heart carries you through all the hard times.',
  'A new perspective will come with the new year.',
]

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(process.env.RPC_URL),
})

// Fund recipient account on startup
await Actions.faucet.fundSync(client, { account })
