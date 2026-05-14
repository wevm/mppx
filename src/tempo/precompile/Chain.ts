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
import type { Uint96 } from './Types.js'
import { uint96 } from './Types.js'

export type ChannelState = {
  settled: Uint96
  deposit: Uint96
  closeRequestedAt: number
}

export type Channel = {
  descriptor: ChannelDescriptor
  state: ChannelState
}

function stateFromTuple(state: {
  settled: bigint
  deposit: bigint
  closeRequestedAt: number
}): ChannelState {
  return {
    settled: uint96(state.settled),
    deposit: uint96(state.deposit),
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

/** Encodes a TIP-1034 approve-less `open` call. */
export function encodeOpen(parameters: {
  payee: Address
  operator: Address
  token: Address
  deposit: Uint96
  salt: Hex
  authorizedSigner: Address
}): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [
      parameters.payee,
      parameters.operator,
      parameters.token,
      parameters.deposit,
      parameters.salt,
      parameters.authorizedSigner,
    ],
  })
}

/** Encodes a descriptor-based TIP-1034 `settle` call. */
export function encodeSettle(
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'settle',
    args: [descriptorTuple(descriptor), cumulativeAmount, signature],
  })
}

/** Encodes a descriptor-based TIP-1034 `topUp` call. */
export function encodeTopUp(descriptor: ChannelDescriptor, additionalDeposit: Uint96): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'topUp',
    args: [descriptorTuple(descriptor), additionalDeposit],
  })
}

/** Encodes a descriptor-based TIP-1034 `close` call. */
export function encodeClose(
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  captureAmount: Uint96,
  signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'close',
    args: [descriptorTuple(descriptor), cumulativeAmount, captureAmount, signature],
  })
}

/** Encodes a descriptor-based TIP-1034 `requestClose` call. */
export function encodeRequestClose(descriptor: ChannelDescriptor): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'requestClose',
    args: [descriptorTuple(descriptor)],
  })
}

/** Encodes a descriptor-based TIP-1034 `withdraw` call. */
export function encodeWithdraw(descriptor: ChannelDescriptor): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'withdraw',
    args: [descriptorTuple(descriptor)],
  })
}

/** Reads immutable descriptor and mutable state for a TIP-1034 channel. */
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

/** Reads mutable state for a TIP-1034 channel ID. */
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

/** Reads mutable states for TIP-1034 channel IDs in one precompile call. */
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

/** Broadcasts a descriptor-based TIP-1034 settle transaction with optional fee sponsorship. */
export async function settle(
  client: Client,
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  signature: Hex,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeSettle(descriptor, cumulativeAmount, signature),
    'settle',
    options,
  )
}

/** Broadcasts a descriptor-based TIP-1034 top-up transaction with optional fee sponsorship. */
export async function topUp(
  client: Client,
  descriptor: ChannelDescriptor,
  additionalDeposit: Uint96,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeTopUp(descriptor, additionalDeposit),
    'topUp',
    options,
  )
}

/** Broadcasts a descriptor-based TIP-1034 request-close transaction with optional fee sponsorship. */
export async function requestClose(
  client: Client,
  descriptor: ChannelDescriptor,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeRequestClose(descriptor),
    'requestClose',
    options,
  )
}

/** Broadcasts a descriptor-based TIP-1034 withdraw transaction with optional fee sponsorship. */
export async function withdraw(
  client: Client,
  descriptor: ChannelDescriptor,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  return sendPrecompileTransaction(client, escrow, encodeWithdraw(descriptor), 'withdraw', options)
}

/** Broadcasts a descriptor-based TIP-1034 close transaction with optional fee sponsorship. */
export async function close(
  client: Client,
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  captureAmount: Uint96,
  signature: Hex,
  escrow: Address = tip20ChannelEscrow,
  options?: SendOptions,
): Promise<Hex> {
  return sendPrecompileTransaction(
    client,
    escrow,
    encodeClose(descriptor, cumulativeAmount, captureAmount, signature),
    'close',
    options,
  )
}
