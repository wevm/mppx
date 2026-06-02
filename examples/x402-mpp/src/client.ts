import { Mppx, evm, tempo } from 'mppx/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173'
const flow = process.env.FLOW ?? 'all'
const mppPrivateKey = (process.env.MPP_PRIVATE_KEY ?? generatePrivateKey()) as `0x${string}`
const configuredX402PrivateKey = (process.env.X402_PRIVATE_KEY ?? process.env.MPP_PRIVATE_KEY) as
  | `0x${string}`
  | undefined

if (!['all', 'mpp', 'x402'].includes(flow)) throw new Error('FLOW must be all, mpp, or x402.')
if (flow !== 'mpp' && !configuredX402PrivateKey) {
  throw new Error('Set MPP_PRIVATE_KEY or X402_PRIVATE_KEY, then fund it with Base Sepolia USDC.')
}

const tempoClient = createClient({
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(process.env.MPPX_RPC_URL),
})
const mppAccount = privateKeyToAccount(mppPrivateKey)
const x402Account = privateKeyToAccount(configuredX402PrivateKey ?? mppPrivateKey)

if (flow !== 'x402') {
  console.log('Funding mpp account from Tempo testnet faucet...')
  await Actions.faucet.fundSync(tempoClient, { account: mppAccount, timeout: 30_000 })
}

if (flow !== 'mpp') {
  console.log(`x402 account: ${x402Account.address}`)
  console.log('Fund this address with Base Sepolia USDC at https://faucet.circle.com/')
}

const mpp = Mppx.create({
  methods: [
    tempo.charge({
      account: mppAccount,
      getClient: () => tempoClient,
    }),
  ],
  polyfill: false,
})

const x402 = Mppx.create({
  methods: [
    evm.charge({
      account: x402Account,
      currencies: [evm.assets.baseSepolia.USDC],
      maxAmount: '0.01',
      networks: [84532],
    }),
  ],
  orderChallenges: (candidates) =>
    candidates.filter(({ challenge }) => challenge.request.scheme === 'exact'),
  polyfill: false,
})

if (flow !== 'x402') {
  await fetchPaid('mpp route', mpp, '/api/mpp')
  await fetchPaid('composed route via mpp', mpp, '/api/paid')
}

if (flow !== 'mpp') {
  await fetchPaid('x402 route', x402, '/api/x402')
  await fetchPaid('composed route via x402', x402, '/api/paid')
}

async function fetchPaid(label: string, payments: typeof mpp | typeof x402, path: string) {
  const response = await payments.fetch(`${baseUrl}${path}`)
  const receipt =
    response.headers.get('Payment-Receipt') ?? response.headers.get('PAYMENT-RESPONSE')
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`)
  console.log(`${label}: ${await response.text()}`)
  console.log(`${label} receipt: ${receipt ? 'yes' : 'no'}`)
}
