import { Mpay, tempo } from 'mpay/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(generatePrivateKey())
const chainId = 42431
const currency = '0x20c0000000000000000000000000000000000001' as const // alphaUSD
const rpcUrl = 'https://rpc.moderato.tempo.xyz'

const mpay = Mpay.create({
  method: tempo({
    chainId,
    feePayer: account,
    rpcUrl,
  }),
  realm: 'localhost',
  secretKey: 'top-secret-should-be-hidden-somewhere',
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Free
  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  // Paid
  if (url.pathname === '/api/fortune') {
    const result = await mpay.charge({
      description: 'Fortune for you',
      request: {
        amount: '1000000', // 1 USD
        currency,
        expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        recipient: account.address,
      },
    })(request)

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
import { Actions } from 'viem/tempo'

const client = createClient({
  pollingInterval: 200,
  transport: http(rpcUrl),
})

// Fund recipient account on startup
await Actions.faucet.fundSync(client, { account })
