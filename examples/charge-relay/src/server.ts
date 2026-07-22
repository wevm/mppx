import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Mppx } from 'mppx/hono'
import { tempo } from 'mppx/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'
import { pathusd } from 'viem/tokens'

const apiKey = process.env.TEMPO_API_KEY
if (!apiKey) throw new Error('Set TEMPO_API_KEY to a Tempo API key with the mpp:write scope.')

const apiBaseUrl = process.env.TEMPO_API_BASE_URL ?? 'https://api.tempo.xyz'
const currency = pathusd(Chain.testnet.id).address
const account = privateKeyToAccount(generatePrivateKey())
const method = tempo.charge({
  account,
  currency,
  recipient: account.address,
  // MPPX still creates and binds the challenge. Tempo API validates the
  // returned credential and broadcasts the transaction on the server's behalf.
  // Relay failures are exposed to the payer as a generic MPPX 402 response.
  relay: { apiBaseUrl, apiKey },
  supportedModes: ['pull'],
  testnet: true,
})
const payments = Mppx.create({
  methods: [method],
  secretKey: process.env.MPP_SECRET_KEY ?? 'mppx-demo-tempo-api-relay-secret-key',
})

const app = new Hono()
app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.get('/api/photo', payments.charge({ amount: '0.01', description: 'Random stock photo' }), (c) =>
  c.json({ url: 'https://picsum.photos/1024/1024' }),
)

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 5173) })
