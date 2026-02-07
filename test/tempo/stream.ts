import { type Account, type Address, encodeFunctionData, type Hex, zeroAddress } from 'viem'
import {
  deployContract,
  prepareTransactionRequest,
  readContract,
  signTransaction,
  waitForTransactionReceipt,
  writeContractSync,
} from 'viem/actions'
import artifact from '../fixtures/TempoStreamChannel.json' with { type: 'json' }
import { client } from './viem.js'

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

export async function deployEscrow(): Promise<Address> {
  const hash = await deployContract(client, {
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
  })
  const receipt = await waitForTransactionReceipt(client, { hash })
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

  await writeContractSync(client, {
    account: payer,
    address: token,
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [escrow, deposit],
  })

  const channelId = await readContract(client, {
    address: escrow,
    abi: artifact.abi,
    functionName: 'computeChannelId',
    args: [payer.address, payee, token, deposit, salt, authorizedSigner],
  })

  const txReceipt = await writeContractSync(client, {
    account: payer,
    address: escrow,
    abi: artifact.abi,
    functionName: 'open',
    args: [payee, token, deposit, salt, authorizedSigner],
  })

  return { channelId: channelId as Hex, txHash: txReceipt.transactionHash }
}

export async function topUpChannel(params: {
  escrow: Address
  payer: Account
  channelId: Hex
  token: Address
  amount: bigint
}): Promise<{ txHash: Hex }> {
  const { escrow, payer, channelId, token, amount } = params

  await writeContractSync(client, {
    account: payer,
    address: token,
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [escrow, amount],
  })

  const txReceipt = await writeContractSync(client, {
    account: payer,
    address: escrow,
    abi: artifact.abi,
    functionName: 'topUp',
    args: [channelId, amount],
  })

  return { txHash: txReceipt.transactionHash }
}

export async function closeChannelOnChain(params: {
  escrow: Address
  payee: Account
  channelId: Hex
  cumulativeAmount: bigint
  signature: Hex
}): Promise<{ txHash: Hex }> {
  const { escrow, payee, channelId, cumulativeAmount, signature } = params

  const txReceipt = await writeContractSync(client, {
    account: payee,
    address: escrow,
    abi: artifact.abi,
    functionName: 'close',
    args: [channelId, cumulativeAmount, signature],
  })

  return { txHash: txReceipt.transactionHash }
}

export async function signOpenChannel(params: {
  escrow: Address
  payer: Account
  payee: Address
  token: Address
  deposit: bigint
  salt: Hex
  authorizedSigner?: Address
}): Promise<{ channelId: Hex; serializedTransaction: Hex }> {
  const { escrow, payer, payee, token, deposit, salt } = params
  const authorizedSigner = params.authorizedSigner ?? zeroAddress

  const channelId = await readContract(client, {
    address: escrow,
    abi: artifact.abi,
    functionName: 'computeChannelId',
    args: [payer.address, payee, token, deposit, salt, authorizedSigner],
  })

  const approveData = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [escrow, deposit],
  })
  const openData = encodeFunctionData({
    abi: artifact.abi,
    functionName: 'open',
    args: [payee, token, deposit, salt, authorizedSigner],
  })

  const prepared = await prepareTransactionRequest(client, {
    account: payer,
    calls: [
      { to: token, data: approveData },
      { to: escrow, data: openData },
    ],
  } as never)
  prepared.gas = prepared.gas! + 5_000n

  const serializedTransaction = await signTransaction(client, prepared as never)

  return { channelId: channelId as Hex, serializedTransaction: serializedTransaction as Hex }
}

export async function signTopUpChannel(params: {
  escrow: Address
  payer: Account
  channelId: Hex
  token: Address
  amount: bigint
}): Promise<{ serializedTransaction: Hex }> {
  const { escrow, payer, channelId, token, amount } = params

  const approveData = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [escrow, amount],
  })
  const topUpData = encodeFunctionData({
    abi: artifact.abi,
    functionName: 'topUp',
    args: [channelId, amount],
  })

  const prepared = await prepareTransactionRequest(client, {
    account: payer,
    calls: [
      { to: token, data: approveData },
      { to: escrow, data: topUpData },
    ],
  } as never)
  prepared.gas = prepared.gas! + 5_000n

  const serializedTransaction = await signTransaction(client, prepared as never)

  return { serializedTransaction: serializedTransaction as Hex }
}
