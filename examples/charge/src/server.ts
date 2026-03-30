import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

import { Mppx, tempo } from '../../_shared/mppxSource.server.js'

const account = privateKeyToAccount(generatePrivateKey())

const mppx = Mppx.create({
  methods: [
    tempo({
      account,
      currency: '0x20c0000000000000000000000000000000000000',
      feePayer: true,
      html: {},
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
  if (url.pathname === '/api/photo') {
    const result = await mppx.charge({
      amount: '0.01',
      description: 'Random stock photo',
    })(request)

    if (result.status === 402) return result.challenge

    const res = await fetch('https://picsum.photos/1024/1024')
    const photoUrl = res.url

    return result.withReceipt(Response.json({ url: photoUrl }))
  }

  return null
}

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(process.env.MPPX_RPC_URL),
})

// Fund recipient account on startup
await Actions.faucet.fundSync(client, { account })
