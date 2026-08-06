import { Mppx, tempo } from 'mppx/server'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000000' as const // pathUSD

// `Mppx.create()` requires a secret key so challenge IDs can be verified
// statelessly. The example ships with a default demo key so it works
// out of the box, but still allows override via `MPP_SECRET_KEY`.
const secretKey = process.env.MPP_SECRET_KEY ?? 'mppx-demo-charge-secret-key-minimum-32'

const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo({
      account,
      currency,
      feePayer: true,
      html: true,
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
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(process.env.MPPX_RPC_URL),
})

// Fund recipient account on startup
await Actions.faucet.fundSync(client, { account })
