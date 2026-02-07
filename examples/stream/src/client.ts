import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Challenge } from 'mpay'
import { Mpay, tempo } from 'mpay/client'
import { type Address, createClient, createWalletClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'
import {
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions'

const STATE_FILE = '.channel.json'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const currency = '0x20c0000000000000000000000000000000000001' as const
const escrowContract = '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70' as const
const chainId = 42431
const deposit = 10_000_000n
const txTimeout = 30_000

const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

const escrowOpenAbi = [
  {
    type: 'function',
    name: 'open',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'deposit', type: 'uint128' },
      { name: 'salt', type: 'bytes32' },
      { name: 'authorizedSigner', type: 'address' },
    ],
    outputs: [{ name: 'channelId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
] as const

interface ChannelFile {
  privateKey: string
  channelId?: string
  cumulativeAmount?: string
}

function loadState(): ChannelFile {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  }
  const state: ChannelFile = { privateKey: generatePrivateKey() }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  return state
}

function saveState(state: ChannelFile) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function main() {
  const state = loadState()
  const account = privateKeyToAccount(state.privateKey as Hex)
  console.log(`Client account: ${account.address}`)

  const client = createClient({
    account,
    chain: tempoModerato,
    pollingInterval: 1_000,
    transport: http(),
  })

  const walletClient = createWalletClient({
    account,
    chain: tempoModerato,
    pollingInterval: 1_000,
    transport: http(),
  })

  console.log('Funding account via faucet...')
  await Actions.faucet.fundSync(client, { account, timeout: txTimeout })
  console.log('Account funded')

  const balance = await Actions.token.getBalance(client, {
    account,
    token: currency,
  })
  console.log(`Balance: ${Number(balance) / 1e6} alphaUSD`)

  const mpay = Mpay.create({
    methods: [
      tempo.stream({
        account,
        walletClient,
        escrowContract,
        chainId,
      }),
    ],
  })

  const prompt = process.argv[2] ?? 'Tell me something interesting'
  console.log(`\nPrompt: ${prompt}`)
  console.log('Requesting /api/chat...')

  const initialResponse = await fetch(`${BASE_URL}/api/chat?prompt=${encodeURIComponent(prompt)}`)
  if (initialResponse.status !== 402) {
    console.log(`Unexpected status: ${initialResponse.status}`)
    console.log(await initialResponse.text())
    return
  }

  const challenge = Challenge.fromResponse(initialResponse)
  console.log(`Got 402 challenge (intent: ${challenge.intent}, method: ${challenge.method})`)

  const payee = challenge.request.recipient as Address

  let channelId: Hex
  let cumulativeAmount: bigint
  let isNewChannel = false
  let openTxHash: Hex | undefined

  if (state.channelId) {
    channelId = state.channelId as Hex
    cumulativeAmount = BigInt(state.cumulativeAmount ?? '0')
    console.log(`Reusing existing channel: ${channelId}`)
  } else {
    isNewChannel = true
    console.log('Opening new payment channel...')

    console.log('  Approving token spend...')
    const approveHash = await writeContract(client, {
      address: currency,
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [escrowContract, deposit],
    })
    await waitForTransactionReceipt(client, { hash: approveHash, timeout: txTimeout })

    const salt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex

    console.log('  Opening channel on escrow...')
    const { result } = await simulateContract(client, {
      address: escrowContract,
      abi: escrowOpenAbi,
      functionName: 'open',
      args: [payee, currency, deposit, salt, account.address],
    })
    channelId = result

    openTxHash = await writeContract(client, {
      address: escrowContract,
      abi: escrowOpenAbi,
      functionName: 'open',
      args: [payee, currency, deposit, salt, account.address],
    })
    await waitForTransactionReceipt(client, { hash: openTxHash, timeout: txTimeout })

    cumulativeAmount = 0n
    state.channelId = channelId
    state.cumulativeAmount = '0'
    saveState(state)
    console.log(`  Channel opened: ${channelId}`)
  }

  const voucherAmount = 1_000_000n
  cumulativeAmount += voucherAmount

  const action = isNewChannel ? 'open' : 'voucher'
  console.log(`Creating ${action} credential (cumulative: ${cumulativeAmount})...`)

  const credential = await mpay.createCredential(initialResponse, {
    action,
    channelId,
    cumulativeAmount,
    ...(openTxHash && { hash: openTxHash }),
  })

  state.cumulativeAmount = cumulativeAmount.toString()
  saveState(state)

  console.log('Sending authenticated request...\n')

  const authedResponse = await fetch(`${BASE_URL}/api/chat?prompt=${encodeURIComponent(prompt)}`, {
    headers: { Authorization: credential },
  })

  if (!authedResponse.ok) {
    console.log(`Error: ${authedResponse.status}`)
    console.log(await authedResponse.text())
    return
  }

  const receipt = authedResponse.headers.get('Payment-Receipt')
  if (receipt) console.log(`Payment-Receipt: ${receipt.slice(0, 40)}...`)

  const reader = authedResponse.body?.getReader()
  if (!reader) {
    console.log('No response body')
    return
  }

  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value, { stream: true })
    const lines = chunk.split('\n')

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      try {
        const { token } = JSON.parse(data) as { token: string }
        process.stdout.write(token)
      } catch {}
    }
  }

  console.log('\n\nStream complete.')
  console.log(`Cumulative amount: ${cumulativeAmount} (${Number(cumulativeAmount) / 1e6} alphaUSD)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
