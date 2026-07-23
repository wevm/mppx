import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Errors, Receipt } from 'mppx'
import { Mppx } from 'mppx/hono'
import { tempo } from 'mppx/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'
import { pathusd } from 'viem/tokens'

const apiKey = process.env.TEMPO_API_KEY
if (!apiKey) throw new Error('Set TEMPO_API_KEY to a Tempo API key with the mpp:write scope.')
const tempoApiKey = apiKey

const apiUrl = process.env.TEMPO_API_URL ?? 'https://api.tempo.xyz'
const currency = pathusd(Chain.testnet.id).address
const account = privateKeyToAccount(generatePrivateKey())
const method = tempo.charge({
  account,
  currency,
  recipient: account.address,
  // To replace the local `relay` implementation below with the built-in adapter:
  // relay: { apiBaseUrl: apiUrl, apiKey },
  supportedModes: ['pull'],
  testnet: true,
})
const payments = Mppx.create({
  methods: [
    {
      ...method,
      async validate(parameters: Parameters<NonNullable<typeof method.validate>>[0]) {
        const { credential, request } = parameters
        await relay('/v1/mpp/validate', credential)
        return {
          challenge: credential.challenge,
          credential,
          details: {},
          intent: method.intent,
          method: method.name,
          request,
          ...(credential.source ? { source: credential.source } : {}),
        }
      },
      async broadcast(parameters: Parameters<NonNullable<typeof method.broadcast>>[0]) {
        const { credential } = parameters
        const receipt = await relay('/v1/mpp/broadcast', credential, {
          'idempotency-key': `mppx_${credential.challenge.id}`,
        })
        return Receipt.from({ ...receipt, status: 'success' })
      },
    },
  ],
  secretKey: process.env.MPP_SECRET_KEY ?? 'mppx-demo-tempo-api-relay-secret-key',
})

const app = new Hono()
app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.get('/api/photo', payments.charge({ amount: '0.01', description: 'Random stock photo' }), (c) =>
  c.json({ url: 'https://picsum.photos/1024/1024' }),
)

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 5173) })

async function relay(
  path: '/v1/mpp/broadcast' | '/v1/mpp/validate',
  credential: { challenge: Record<string, unknown>; payload: unknown },
  headers: Record<string, string> = {},
) {
  let response: Response
  try {
    response = await fetch(new URL(path, apiUrl), {
      body: JSON.stringify({ challenge: credential.challenge, payload: credential.payload }),
      headers: {
        'content-type': 'application/json',
        'tempo-api-key': tempoApiKey,
        ...headers,
      },
      method: 'POST',
    })
  } catch {
    throw new Errors.VerificationFailedError({ reason: 'Tempo API relay request failed' })
  }

  const result = (await response.json().catch(() => undefined)) as RelayResult | undefined
  if (!response.ok)
    throw new Errors.VerificationFailedError({
      reason: `Tempo API relay returned HTTP ${response.status}`,
    })
  if (!result || result.success !== true)
    throw new Errors.VerificationFailedError({
      reason: result?.error?.message ?? result?.error?.code ?? 'Tempo API relay rejected payment',
    })
  return result.receipt
}

type RelayResult =
  | {
      receipt: {
        externalId?: string | undefined
        method: string
        reference: string
        timestamp: string
      }
      success: true
    }
  | { error: { code?: string | undefined; message?: string | undefined }; success: false }
