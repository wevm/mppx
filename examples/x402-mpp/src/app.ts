import { Hono } from 'hono'
import { Mppx, evm, tempo } from 'mppx/server'
import type { Facilitator } from 'mppx/x402'
import type { Account, Client } from 'viem'
import { createClient, http } from 'viem'
import { Chain } from 'viem/tempo'

const currency = '0x20c0000000000000000000000000000000000000' as const // pathUSD

export type AppOptions = {
  account: Account
  facilitator?: string | Facilitator | undefined
  getTempoClient?: (() => Client) | undefined
  recipient?: `0x${string}` | undefined
  secretKey?: string | undefined
}

/** Creates the example server with mpp, x402, and composed payment routes. */
export function createApp(options: AppOptions) {
  const recipient = options.recipient ?? options.account.address
  const facilitator =
    options.facilitator ?? process.env.X402_FACILITATOR_URL ?? 'https://facilitator.x402.rs'
  const getTempoClient = options.getTempoClient ?? (() => createTempoClient())

  const payments = Mppx.create({
    methods: [
      tempo.charge({
        account: options.account,
        currency,
        feePayer: true,
        getClient: getTempoClient,
        recipient,
        testnet: true,
      }),
      evm.charge({
        currency: evm.assets.baseSepolia.USDC,
        recipient,
        x402: { facilitator },
      }),
    ],
    secretKey: options.secretKey ?? 'x402-mpp-example',
  })

  const paid = payments.compose(
    [
      payments.tempo.charge,
      {
        amount: '0.01',
        chainId: Chain.testnet.id,
        description: 'Composed mpp payment',
      },
    ],
    [
      payments.evm.charge,
      {
        amount: '0.01',
        description: 'Composed x402 payment',
      },
    ],
  )

  const app = new Hono()

  app.get('/api/health', (c) => c.json({ status: 'ok' }))

  app.get('/api/mpp', async (c) => {
    const result = await payments.tempo.charge({
      amount: '0.01',
      chainId: Chain.testnet.id,
      description: 'MPP-only payment',
    })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(c.json({ data: 'paid with mpp' }))
  })

  app.get('/api/x402', async (c) => {
    const result = await payments.evm.charge({
      amount: '0.01',
      description: 'x402-only payment',
    })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(c.json({ data: 'paid with x402' }))
  })

  app.get('/api/paid', async (c) => {
    const result = await paid(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(c.json({ data: 'paid with mpp or x402' }))
  })

  return app
}

/** Creates the Tempo testnet client used by the example server. */
export function createTempoClient(): Client {
  return createClient({
    chain: Chain.testnet,
    pollingInterval: 1_000,
    transport: http(process.env.MPPX_RPC_URL),
  })
}
