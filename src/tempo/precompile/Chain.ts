import type { Account, Address, Client, Hex } from 'viem'
import { encodeFunctionData } from 'viem'
import {
  prepareTransactionRequest,
  readContract,
  sendRawTransactionSync,
  sendTransaction,
  signTransaction,
} from 'viem/actions'
import { Transaction } from 'viem/tempo'

import { BadRequestError, VerificationFailedError } from '../../Errors.js'
import type * as FeePayer from '../internal/fee-payer.js'
import { resolveFeeToken } from '../internal/fee-token.js'
import type { ChannelDescriptor } from './Channel.js'
import { tip20ChannelEscrow } from './Constants.js'
import { escrowAbi } from './escrow.abi.js'

const UINT96_MAX = 2n ** 96n - 1n

function assertUint96(amount: bigint): void {
  if (amount < 0n || amount > UINT96_MAX) {
    throw new VerificationFailedError({ reason: 'amount exceeds uint96 range' })
  }
}

/**
 * On-chain channel state from the TIP20EscrowChannel precompile.
 */
export type ChannelState = {
  settled: bigint
  deposit: bigint
  closeRequestedAt: number
}

/**
 * On-chain channel descriptor and state from the TIP20EscrowChannel precompile.
 */
export type Channel = {
  descriptor: ChannelDescriptor
  state: ChannelState
}

/**
 * Read channel descriptor and state from the TIP20EscrowChannel precompile.
 */
export async function getChannel(
  client: Client,
  descriptor: ChannelDescriptor,
  escrow: Address = tip20ChannelEscrow,
): Promise<Channel> {
  const channel = await readContract(client, {
    address: escrow,
    abi: escrowAbi,
    functionName: 'getChannel',
    args: [descriptorTuple(descriptor)],
  })
  return {
    descriptor: channel.descriptor,
    state: stateFromTuple(channel.state),
  }
}

/**
 * Read channel state from the TIP20EscrowChannel precompile.
 */
export async function getChannelState(
  client: Client,
  channelId: Hex,
  escrow: Address = tip20ChannelEscrow,
): Promise<ChannelState> {
  const state = await readContract(client, {
    address: escrow,
    abi: escrowAbi,
    functionName: 'getChannelState',
    args: [channelId],
  })
  return stateFromTuple(state)
}

/**
 * Read channel states from the TIP20EscrowChannel precompile.
 */
export async function getChannelStatesBatch(
  client: Client,
  channelIds: readonly Hex[],
  escrow: Address = tip20ChannelEscrow,
): Promise<ChannelState[]> {
  const states = await readContract(client, {
    address: escrow,
    abi: escrowAbi,
    functionName: 'getChannelStatesBatch',
    args: [channelIds],
  })
  return states.map(stateFromTuple)
}

type SendOptions = {
  account?: Account | undefined
  candidateFeeTokens?: readonly Address[] | undefined
  feePayer?: Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  feeToken?: Address | undefined
}

/**
 * Submit a settle transaction on-chain.
 */
export async function settleOnChain(
  client: Client,
  descriptor: ChannelDescriptor,
  cumulativeAmount: bigint,
  signature: Hex,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  assertUint96(cumulativeAmount)
  const args = [descriptorTuple(descriptor), cumulativeAmount, signature] as const
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: 'settle', args }),
    'settle',
    options,
  )
}

/**
 * Submit a top-up transaction on-chain.
 */
export async function topUpOnChain(
  client: Client,
  descriptor: ChannelDescriptor,
  additionalDeposit: bigint,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  assertUint96(additionalDeposit)
  const args = [descriptorTuple(descriptor), additionalDeposit] as const
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: 'topUp', args }),
    'topUp',
    options,
  )
}

/**
 * Submit a request-close transaction on-chain.
 */
export async function requestCloseOnChain(
  client: Client,
  descriptor: ChannelDescriptor,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  const args = [descriptorTuple(descriptor)] as const
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: 'requestClose', args }),
    'requestClose',
    options,
  )
}

/**
 * Submit a withdraw transaction on-chain.
 */
export async function withdrawOnChain(
  client: Client,
  descriptor: ChannelDescriptor,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  const args = [descriptorTuple(descriptor)] as const
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: 'withdraw', args }),
    'withdraw',
    options,
  )
}

/**
 * Submit a close transaction on-chain.
 */
export async function closeOnChain(
  client: Client,
  descriptor: ChannelDescriptor,
  cumulativeAmount: bigint,
  captureAmount: bigint,
  signature: Hex,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  assertUint96(cumulativeAmount)
  assertUint96(captureAmount)
  const args = [descriptorTuple(descriptor), cumulativeAmount, captureAmount, signature] as const
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: 'close', args }),
    'close',
    options,
  )
}

function stateFromTuple(state: {
  settled: bigint
  deposit: bigint
  closeRequestedAt: number
}): ChannelState {
  assertUint96(state.settled)
  assertUint96(state.deposit)
  return {
    settled: state.settled,
    deposit: state.deposit,
    closeRequestedAt: state.closeRequestedAt,
  }
}

function descriptorTuple(descriptor: ChannelDescriptor) {
  return {
    payer: descriptor.payer,
    payee: descriptor.payee,
    operator: descriptor.operator,
    token: descriptor.token,
    salt: descriptor.salt,
    authorizedSigner: descriptor.authorizedSigner,
    expiringNonceHash: descriptor.expiringNonceHash,
  } as const
}

function assertFeePayerPolicy(
  prepared: {
    gas?: bigint | undefined
    maxFeePerGas?: bigint | undefined
    maxPriorityFeePerGas?: bigint | undefined
  },
  policy: Partial<FeePayer.Policy> | undefined,
) {
  if (!policy) return
  if (policy.maxGas !== undefined && (prepared.gas ?? 0n) > policy.maxGas)
    throw new BadRequestError({ reason: 'fee-payer policy maxGas exceeded' })
  if (policy.maxFeePerGas !== undefined && (prepared.maxFeePerGas ?? 0n) > policy.maxFeePerGas)
    throw new BadRequestError({ reason: 'fee-payer policy maxFeePerGas exceeded' })
  if (
    policy.maxPriorityFeePerGas !== undefined &&
    (prepared.maxPriorityFeePerGas ?? 0n) > policy.maxPriorityFeePerGas
  )
    throw new BadRequestError({ reason: 'fee-payer policy maxPriorityFeePerGas exceeded' })
  if (
    policy.maxTotalFee !== undefined &&
    (prepared.gas ?? 0n) * (prepared.maxFeePerGas ?? 0n) > policy.maxTotalFee
  )
    throw new BadRequestError({ reason: 'fee-payer policy maxTotalFee exceeded' })
}

async function sendPrecompileTransaction(
  client: Client,
  to: Address,
  data: Hex,
  label: string,
  options?: SendOptions,
): Promise<Hex> {
  if (options?.feePayer) {
    const account = options.account ?? client.account
    if (!account) throw new Error(`Cannot ${label} precompile channel: no account available.`)
    const feeToken =
      options.feeToken ??
      (await resolveFeeToken({
        account: options.feePayer.address,
        candidateTokens: options.candidateFeeTokens,
        client,
      }))
    const prepared = await prepareTransactionRequest(client, {
      account,
      calls: [{ to, data }],
      feePayer: true,
      ...(feeToken ? { feeToken } : {}),
    } as never)
    assertFeePayerPolicy(prepared, options.feePayerPolicy)
    const serialized = (await signTransaction(client, {
      ...prepared,
      account,
      feePayer: options.feePayer,
    } as never)) as Hex
    const receipt = await sendRawTransactionSync(client, {
      serializedTransaction: serialized as Transaction.TransactionSerializedTempo,
    })
    if (receipt.status !== 'success')
      throw new VerificationFailedError({
        reason: `${label} precompile transaction reverted: ${receipt.transactionHash}`,
      })
    return receipt.transactionHash
  }

  return sendTransaction(client, {
    ...(options?.account ? { account: options.account } : {}),
    to,
    data,
    ...(options?.feeToken ? { feeToken: options.feeToken } : {}),
  } as never)
}
