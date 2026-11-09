import { Hono } from 'hono'
import { Errors, Receipt } from 'mppx'
import { Mppx } from 'mppx/hono'
import { Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

type Env = {
  /** Payee account key: receives payments. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs, so they verify statelessly. */
  MPP_SECRET_KEY: string
  /** Tempo API key with the `mpp:write` scope. */
  TEMPO_API_KEY: string
  /** Optional Tempo API URL, such as a self-hosted or preview Tempo API. */
  TEMPO_API_URL?: string | undefined
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

let payments: ReturnType<typeof createPayments> | undefined
function createPayments(env: Env) {
  if (!env.TEMPO_API_KEY)
    throw new Error('Set TEMPO_API_KEY to a Tempo API key with the mpp:write scope.')
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  const methods = tempo.charge({
    account,
    chainId: Chain.testnet.id,
    getClient: () => client,
    recipient: account.address,
    // The relay below validates and broadcasts every credential and enforces single use, so
    // tempo.charge's own replay store is never read. Passing one explicitly keeps it from
    // refusing to start in production without a shared store.
    store: Store.memory(),
    // To replace the local `relay` implementation below with the built-in adapter:
    // relay: { apiBaseUrl: env.TEMPO_API_URL, apiKey: env.TEMPO_API_KEY },
    supportedModes: ['pull'],
  })
  return Mppx.create({
    methods: [
      methods.map((method) => ({
        ...method,
        async validate(parameters: Parameters<NonNullable<typeof method.validate>>[0]) {
          const { credential, request } = parameters
          await relay(env, '/v1/mpp/validate', credential)
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
          const receipt = await relay(env, '/v1/mpp/broadcast', credential, {
            'idempotency-key': `mpp_${credential.challenge.id}`,
          })
          return Receipt.from({ ...receipt, status: 'success' })
        },
      })),
    ],
    secretKey: env.MPP_SECRET_KEY,
  })
}

const app = new Hono<{ Bindings: Env }>()
app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.get(
  '/api/photo',
  (c, next) => {
    payments ??= createPayments(c.env)
    return payments.charge({ amount: '0.01', description: 'Random stock photo' })(c, next)
  },
  (c) => c.json({ url: 'https://picsum.photos/1024/1024' }),
)

// A Hono app is a Worker: its `fetch(request, env)` serves every request.
export default app

async function relay(
  env: Env,
  path: '/v1/mpp/broadcast' | '/v1/mpp/validate',
  credential: { challenge: Record<string, unknown>; payload: unknown },
  headers: Record<string, string> = {},
) {
  let response: Response
  try {
    response = await fetch(new URL(path, env.TEMPO_API_URL ?? 'https://api.tempo.xyz'), {
      body: JSON.stringify({ challenge: credential.challenge, payload: credential.payload }),
      headers: {
        'content-type': 'application/json',
        'tempo-api-key': env.TEMPO_API_KEY,
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
