import { Mppx, Store, tempo } from 'mppx/server'
import { Authorize } from 'mppx/tempo'
import { createClient, formatUnits, http, parseUnits, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoDevnet, tempoLocalnet, tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

type NetworkName = 'devnet' | 'localnet' | 'testnet'
type AuthorizationView = {
  amount: string
  capturedAmount: string
  currency: Address
  id: Hex
  openTxHash: Hex
  remainingAmount: string
  status: 'authorized' | 'closed' | 'voided'
}

const decimals = 6
const keyPrefix = 'example:authorize:'
const network = resolveNetwork()
const chain =
  network === 'devnet' ? tempoDevnet : network === 'localnet' ? tempoLocalnet : tempoModerato
const rpcUrl = process.env.MPPX_RPC_URL ?? chain.rpcUrls.default.http[0]
const currency = resolveCurrency(network)
const account = privateKeyToAccount(
  (process.env.MPPX_SERVER_PRIVATE_KEY as Hex) ?? generatePrivateKey(),
)
const rawStore = Store.memory()
const authorizationStore = Authorize.Store.fromStore(rawStore, { keyPrefix })
const authorizationIds: Hex[] = []

const client = createClient({
  account,
  chain,
  pollingInterval: 1_000,
  transport: http(rpcUrl),
})

const mppx = Mppx.create({
  methods: [
    tempo.authorize({
      account,
      chainId: chain.id,
      currency,
      decimals,
      getClient: () => client,
      keyPrefix,
      recipient: account.address,
      store: rawStore,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY ?? 'authorize-playground-secret',
})

await Actions.faucet.fundSync(client, { account, timeout: 30_000 }).catch((error) => {
  console.warn('Failed to fund server account. Capture/void may fail until funded.', error)
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') return json({ status: 'ok' })
  if (url.pathname === '/api/config') return json(await getConfig())
  if (url.pathname === '/api/authorizations' && request.method === 'GET')
    return json({ authorizations: await listAuthorizations() })
  if (url.pathname === '/api/authorizations' && request.method === 'POST')
    return createAuthorization(request, url)

  const captureMatch = url.pathname.match(/^\/api\/authorizations\/(0x[0-9a-fA-F]+)\/capture$/)
  if (captureMatch && request.method === 'POST')
    return withJsonError(() => captureAuthorization(captureMatch[1] as Hex, request))

  const voidMatch = url.pathname.match(/^\/api\/authorizations\/(0x[0-9a-fA-F]+)\/void$/)
  if (voidMatch && request.method === 'POST')
    return withJsonError(() => voidAuthorization(voidMatch[1] as Hex))

  return null
}

async function createAuthorization(request: Request, url: URL) {
  const amount = url.searchParams.get('amount')
  if (!amount) return json({ error: 'missing amount' }, { status: 400 })

  const result = await mppx.authorize({
    amount,
    description: `Authorize ${amount} pathUSD`,
    expires: new Date(Date.now() + 20_000),
    externalId: crypto.randomUUID(),
  })(request)

  if (result.status === 402) return result.challenge

  const response = result.withReceipt()
  const body = (await response.clone().json()) as { authorization: { id: Hex } }
  rememberAuthorization(body.authorization.id)
  const authorization = await getAuthorizationView(body.authorization.id)
  return json({ authorization }, { headers: response.headers })
}

async function captureAuthorization(id: Hex, request: Request) {
  const body = (await request.json()) as { amount?: string; close?: boolean }
  if (!body.amount) return json({ error: 'missing amount' }, { status: 400 })

  const receipt = await tempo.capture(rawStore, client, id, {
    account,
    amount: parseUnits(body.amount, decimals).toString(),
    close: body.close,
    keyPrefix,
  })
  rememberAuthorization(id)
  return json({
    authorization: await getAuthorizationView(id),
    receipt: {
      ...receipt,
      capturedAmount: formatAmount(receipt.capturedAmount),
      delta: formatAmount(receipt.delta),
    },
  })
}

async function voidAuthorization(id: Hex) {
  const receipt = await tempo.voidAuthorization(rawStore, client, id, {
    account,
    keyPrefix,
  })
  rememberAuthorization(id)
  return json({
    authorization: await getAuthorizationView(id),
    receipt: {
      ...receipt,
      releasedAmount: formatAmount(receipt.releasedAmount),
    },
  })
}

async function getConfig() {
  const balance = await Actions.token.getBalance(client, { account, token: currency })
  return {
    chainId: chain.id,
    currency,
    decimals,
    network,
    pricePerUnit: '0.25',
    recipient: account.address,
    rpcUrl,
    serverBalance: formatUnits(balance, decimals),
  }
}

async function listAuthorizations() {
  const authorizations = await Promise.all(authorizationIds.map((id) => getAuthorizationView(id)))
  return authorizations.filter((authorization): authorization is AuthorizationView =>
    Boolean(authorization),
  )
}

async function getAuthorizationView(id: Hex): Promise<AuthorizationView | null> {
  const authorization = await authorizationStore.get(id)
  if (!authorization) return null
  const amount = BigInt(authorization.amount)
  const capturedAmount = BigInt(authorization.capturedAmount)
  return {
    amount: formatUnits(amount, decimals),
    capturedAmount: formatUnits(capturedAmount, decimals),
    currency: authorization.channel.descriptor.token,
    id: authorization.channel.id,
    openTxHash: authorization.openTxHash,
    remainingAmount: formatUnits(amount - capturedAmount, decimals),
    status: authorization.status,
  }
}

function rememberAuthorization(id: Hex) {
  const normalized = id.toLowerCase() as Hex
  if (!authorizationIds.some((existing) => existing.toLowerCase() === normalized))
    authorizationIds.unshift(normalized)
}

function formatAmount(value: string | bigint) {
  return formatUnits(BigInt(value), decimals)
}

function resolveNetwork(): NetworkName {
  const value = process.env.MPPX_NETWORK
  if (value === 'devnet' || value === 'localnet' || value === 'testnet') return value
  return 'localnet'
}

function resolveCurrency(network: NetworkName): Address {
  const configured = process.env.MPPX_AUTHORIZE_CURRENCY as Address | undefined
  if (configured) return configured
  if (network === 'testnet') return '0x20c0000000000000000000000000000000000000'
  return '0x20c0000000000000000000000000000000000001'
}

async function withJsonError(fn: () => Promise<Response>) {
  try {
    return await fn()
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...Object.fromEntries(new Headers(init.headers)),
    },
  })
}
