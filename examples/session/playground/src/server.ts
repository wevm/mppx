import { Mppx, Store, tempo } from 'mppx/server'
import { Session } from 'mppx/tempo'
import { createClient, http, isAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { readContract, waitForTransactionReceipt } from 'viem/actions'
import { Actions } from 'viem/tempo'

import { chain, isLocalnet, networkName, rpcUrl, transportOptions } from './config.js'

const account = isLocalnet
  ? mnemonicToAccount('test test test test test test test test test test test junk')
  : privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000001' as const
const pricePerClick = '0.00005'
const pricePerStreamToken = '0.00005'
const localnetFundAmount = 10_000_000_000n
const store = Store.memory()
const latestChannelByPayer = new Map<string, Hex>()
let precompileAvailable: Promise<boolean> | null = null

const client = createClient({
  account,
  chain,
  pollingInterval: 1_000,
  transport: http(rpcUrl, transportOptions),
})

type StoredSessionChannel = {
  channelId: Hex
  deposit: bigint
  descriptor?: { payer?: Address | undefined } | undefined
  finalized: boolean
  highestVoucherAmount: bigint
  spent: bigint
  units: number
}

type PayloadWithPayerDescriptor = {
  descriptor?: { payer?: unknown } | undefined
}

const mppx = Mppx.create({
  methods: [
    tempo.session({
      account,
      chainId: chain.id,
      currency,
      getClient: () => client,
      recipient: account.address,
      settlementSchedule: { units: 10 },
      sse: { poll: true },
      store,
    }),
  ],
  secretKey: 'session-playground-secret',
})

mppx.onPaymentSuccess(trackLatestChannel)

async function trackLatestChannel({
  credential,
  receipt,
}: {
  credential?: { payload?: unknown } | undefined
  receipt: { method: string; channelId?: Hex | undefined }
}) {
  if (receipt.method !== 'tempo' || !('channelId' in receipt)) return
  const channelId = receipt.channelId
  if (!channelId) return
  const channel = (await store.get(channelId)) as StoredSessionChannel | null
  const payer = payloadPayer(credential?.payload) ?? channel?.descriptor?.payer
  if (payer && channelId) latestChannelByPayer.set(payer.toLowerCase(), channelId)
}

function payloadPayer(payload: unknown): Address | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const descriptor = (payload as PayloadWithPayerDescriptor).descriptor
  return typeof descriptor?.payer === 'string' && isAddress(descriptor.payer)
    ? descriptor.payer
    : undefined
}

void fundServer()

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') {
    return Response.json({
      ok: true,
      server: account.address,
      chainId: chain.id,
      network: networkName,
      rpcUrl: rpcUrl ?? null,
      precompileAvailable: await hasPrecompile(),
    })
  }

  if (url.pathname === '/api/fund' && request.method === 'POST') {
    const { address } = (await request.json().catch(() => ({}))) as { address?: string }
    if (!address || !isAddress(address)) {
      return Response.json({ error: 'address required' }, { status: 400 })
    }
    await fundAddress(address)
    return Response.json({ funded: address })
  }

  if (url.pathname === '/api/bootstrap') {
    const payer = url.searchParams.get('payer')
    if (!payer || !isAddress(payer)) return Response.json({ channelId: null })
    const channelId = latestChannelByPayer.get(payer.toLowerCase())
    const channel = channelId ? ((await store.get(channelId)) as StoredSessionChannel | null) : null
    if (!channel || channel.finalized) return Response.json({ channelId: null })
    return Response.json({
      channelId: channel.channelId,
      acceptedCumulative: channel.highestVoucherAmount.toString(),
      deposit: channel.deposit.toString(),
      spent: channel.spent.toString(),
      units: channel.units,
    })
  }

  if (url.pathname === '/api/click') {
    if (!(await hasPrecompile())) {
      return Response.json(
        {
          error:
            'TIP-1034 channel escrow precompile metadata exists in the explorer, but the configured RPC returned no data for TIP-1034 ABI calls.',
        },
        { status: 503 },
      )
    }
    const bootstrapChannelId = normalizeChannelId(url.searchParams.get('channelId'))
    const result = await mppx.session({
      amount: pricePerClick,
      ...(bootstrapChannelId ? { channelId: bootstrapChannelId } : {}),
      suggestedDeposit: '0.0005',
      unitType: 'click',
    })(request)

    if (result.status === 402) return result.challenge
    if (request.method === 'HEAD') return result.withReceipt(new Response(null, { status: 204 }))

    const count = Number(url.searchParams.get('count') ?? '1')
    return result.withReceipt(
      Response.json({
        click: count,
        message: `charged click ${count}`,
        price: pricePerClick,
      }),
    )
  }

  if (url.pathname === '/api/stream') {
    if (!(await hasPrecompile())) {
      return Response.json(
        {
          error:
            'TIP-1034 channel escrow precompile metadata exists in the explorer, but the configured RPC returned no data for TIP-1034 ABI calls.',
        },
        { status: 503 },
      )
    }

    const result = await mppx.session({
      amount: pricePerStreamToken,
      suggestedDeposit: '0.00025',
      unitType: 'token',
    })(request)

    if (result.status === 402) return result.challenge
    if (request.method !== 'GET') return result.withReceipt(new Response(null, { status: 204 }))

    const prompt = url.searchParams.get('prompt') ?? 'SSE demo'
    const tokens = async function* () {
      for (const token of streamTokens(prompt)) {
        yield token
      }
    }
    return result.withReceipt(tokens())
  }

  return null
}

function streamTokens(prompt: string): string[] {
  return [
    'Streaming',
    ' payments',
    ' for',
    ' "',
    prompt,
    '"',
    ' charge',
    ' each',
    ' chunk',
    ' and',
    ' top',
    ' up',
    ' automatically.',
  ]
}

function normalizeChannelId(value: string | null): Hex | undefined {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : undefined
}

async function fundServer() {
  console.log(`Playground server payee: ${account.address}`)
  if (!isLocalnet) await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
  console.log(`Playground server funded on ${networkName}`)
  if (!(await hasPrecompile())) {
    console.warn(
      'TIP-1034 channel escrow precompile metadata exists in the explorer, but this RPC returned no data for TIP-1034 ABI calls.',
    )
  }
}

async function fundAddress(address: Address) {
  if (!isLocalnet) {
    await Actions.faucet.fundSync(client, { account: address, timeout: 30_000 })
    return
  }

  const hash = await Actions.token.transfer(client, {
    account,
    amount: localnetFundAmount,
    chain,
    to: address,
    token: currency,
  })
  await waitForTransactionReceipt(client, { hash })
}

function hasPrecompile() {
  return (precompileAvailable ??= readContract(client, {
    address: Session.Precompile.Constants.tip20ChannelEscrow,
    abi: Session.Precompile.escrowAbi,
    functionName: 'CLOSE_GRACE_PERIOD',
  })
    .then(() => true)
    .catch(() => false))
}
