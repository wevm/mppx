import { Mpay, tempo } from 'mpay/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000001' as const // alphaUSD

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      currency,
      feePayer: true,
      recipient: account,
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
    const result = await mpay.charge({ amount: '1' })(request)

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

////////////////////////////////////////////////////////////////////
// Internal

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 200,
  transport: http(),
})

// Fund recipient account on startup
await Actions.faucet.fundSync(client, { account })
