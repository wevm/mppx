import { createRequire } from 'node:module'
import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  zeroAddress,
} from 'viem'
import { rpcUrl } from './prool.js'
import { accounts, chain, http } from './viem.js'

const require = createRequire(import.meta.url)
const artifact = require('../fixtures/TempoStreamChannel.json') as {
  abi: readonly unknown[]
  bytecode: Hex
}

export const escrowAbi = artifact.abi

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

function publicClient() {
  return createPublicClient({ chain, transport: http(rpcUrl) })
}

function walletClient(account: Account) {
  return createWalletClient({ account, chain, transport: http(rpcUrl) })
}

export async function deployEscrow(): Promise<Address> {
  const deployer = walletClient(accounts[0])
  const pub = publicClient()

  const hash = await deployer.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('deploy failed: no contract address')
  return receipt.contractAddress
}

export async function openChannel(params: {
  escrow: Address
  payer: Account
  payee: Address
  token: Address
  deposit: bigint
  salt: Hex
  authorizedSigner?: Address
}): Promise<{ channelId: Hex; txHash: Hex }> {
  const { escrow, payer, payee, token, deposit, salt } = params
  const authorizedSigner = params.authorizedSigner ?? zeroAddress
  const wallet = walletClient(payer)
  const pub = publicClient()

  const approveHash = await wallet.writeContract({
    address: token,
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [escrow, deposit],
  })
  await pub.waitForTransactionReceipt({ hash: approveHash })

  const { result: channelId } = await pub.simulateContract({
    account: payer,
    address: escrow,
    abi: artifact.abi,
    functionName: 'open',
    args: [payee, token, deposit, salt, authorizedSigner],
  })

  const txHash = await wallet.writeContract({
    address: escrow,
    abi: artifact.abi,
    functionName: 'open',
    args: [payee, token, deposit, salt, authorizedSigner],
  })
  await pub.waitForTransactionReceipt({ hash: txHash })

  return { channelId: channelId as Hex, txHash }
}

export async function topUpChannel(params: {
  escrow: Address
  payer: Account
  channelId: Hex
  token: Address
  amount: bigint
}): Promise<{ txHash: Hex }> {
  const { escrow, payer, channelId, token, amount } = params
  const wallet = walletClient(payer)
  const pub = publicClient()

  const approveHash = await wallet.writeContract({
    address: token,
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [escrow, amount],
  })
  await pub.waitForTransactionReceipt({ hash: approveHash })

  const txHash = await wallet.writeContract({
    address: escrow,
    abi: artifact.abi,
    functionName: 'topUp',
    args: [channelId, amount],
  })
  await pub.waitForTransactionReceipt({ hash: txHash })

  return { txHash }
}

export async function closeChannelOnChain(params: {
  escrow: Address
  payee: Account
  channelId: Hex
  cumulativeAmount: bigint
  signature: Hex
}): Promise<{ txHash: Hex }> {
  const { escrow, payee, channelId, cumulativeAmount, signature } = params
  const wallet = walletClient(payee)
  const pub = publicClient()

  const txHash = await wallet.writeContract({
    address: escrow,
    abi: artifact.abi,
    functionName: 'close',
    args: [channelId, cumulativeAmount, signature],
  })
  await pub.waitForTransactionReceipt({ hash: txHash })

  return { txHash }
}
