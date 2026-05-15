import type { Account, Address, Client, Hex } from 'viem'
import { encodeFunctionData, isAddressEqual, parseEventLogs } from 'viem'
import {
  call,
  prepareTransactionRequest,
  readContract,
  sendRawTransaction,
  sendRawTransactionSync,
  sendTransaction as sendViemTransaction,
  signTransaction,
  waitForTransactionReceipt,
} from 'viem/actions'
import { Transaction } from 'viem/tempo'

import { BadRequestError, VerificationFailedError } from '../../Errors.js'
import * as FeePayer from '../internal/fee-payer.js'
import { resolveFeeToken } from '../internal/fee-token.js'
import * as ChannelUtils from './Channel.js'
import type { ChannelDescriptor } from './Channel.js'
import { tip20ChannelEscrow } from './Constants.js'
import { escrowAbi } from './escrow.abi.js'
import * as ChannelOps from './server/ChannelOps.js'

const UINT96_MAX = 2n ** 96n - 1n

/** viem client shape accepted by raw Tempo transaction actions. */
export type TransactionClient = Parameters<typeof sendRawTransaction>[0]

function assertUint96(amount: bigint): void {
  if (amount < 0n || amount > UINT96_MAX) {
    throw new VerificationFailedError({ reason: 'amount exceeds uint96 range' })
  }
}

function uint96(amount: bigint): bigint {
  assertUint96(amount)
  return amount
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

/** Receipt event shape emitted by TIP20EscrowChannel precompile management calls. */
export type ChannelReceiptEvent = {
  args: {
    channelId: Hex
    expiringNonceHash?: Hex | undefined
    deposit?: bigint | undefined
    newDeposit?: bigint | undefined
    newSettled?: bigint | undefined
    settledToPayee?: bigint | undefined
    refundedToPayer?: bigint | undefined
  }
}

/**
 * Asserts that a deserialized transaction has an existing sender signature.
 */
export function assertSenderSigned(
  transaction: ReturnType<(typeof Transaction)['deserialize']>,
): void {
  if (!transaction.signature || !transaction.from)
    throw new BadRequestError({
      reason: 'Transaction must be signed by the sender before fee payer co-signing',
    })
}

/** Broadcast a raw serialized transaction. */
export async function sendTransaction(client: TransactionClient, transaction: Hex) {
  return sendRawTransaction(client, { serializedTransaction: transaction })
}

/** Wait for a receipt and reject reverted precompile transactions. */
export async function waitForSuccessfulReceipt(client: TransactionClient, hash: Hex) {
  const receipt = await waitForTransactionReceipt(client, { hash })
  if (receipt.status !== 'success')
    throw new VerificationFailedError({ reason: 'precompile transaction reverted' })
  return receipt
}

/** Extract exactly one channel event for a channel ID from a receipt. */
export function getChannelEvent(
  receipt: { logs: Parameters<typeof parseEventLogs>[0]['logs'] },
  name: 'ChannelOpened' | 'TopUp' | 'Settled' | 'ChannelClosed',
  channelId: Hex,
): ChannelReceiptEvent {
  const logs = parseEventLogs({
    abi: escrowAbi,
    eventName: name,
    logs: receipt.logs,
  }) as ChannelReceiptEvent[]
  const matches = logs.filter((log) => log.args.channelId.toLowerCase() === channelId.toLowerCase())
  if (matches.length !== 1)
    throw new VerificationFailedError({
      reason: `expected one ${name} event for credential channelId in receipt`,
    })
  return matches[0]!
}

/** Broadcasts a client-signed management transaction, adding a fee-payer co-signature when requested. */
export async function sendCredentialTransaction(parameters: {
  challengeExpires?: string | undefined
  chainId: number
  client: TransactionClient
  details: Record<string, string>
  expectedFeeToken?: Address | undefined
  feePayer?: Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  label: 'open' | 'topUp'
  serializedTransaction: Hex
  transaction: ReturnType<(typeof Transaction)['deserialize']>
}) {
  const {
    challengeExpires,
    chainId,
    client,
    details,
    expectedFeeToken,
    feePayer,
    feePayerPolicy,
    label,
    serializedTransaction,
    transaction,
  } = parameters

  if (!feePayer) {
    const txHash = await sendTransaction(client, serializedTransaction)
    return waitForSuccessfulReceipt(client, txHash)
  }

  if (!FeePayer.isTempoTransaction(serializedTransaction))
    throw new BadRequestError({ reason: 'Only Tempo (0x76/0x78) transactions are supported' })
  assertSenderSigned(transaction)

  await call(client, {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls ?? [],
    feePayerSignature: undefined,
  } as never)

  const sponsored = FeePayer.prepareSponsoredTransaction({
    account: feePayer,
    challengeExpires,
    chainId,
    details,
    expectedFeeToken,
    policy: feePayerPolicy,
    transaction: {
      ...transaction,
      ...(expectedFeeToken ? { feeToken: transaction.feeToken ?? expectedFeeToken } : {}),
    },
  })
  const serialized = (await signTransaction(client, sponsored as never)) as Hex
  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: serialized as Transaction.TransactionSerializedTempo,
  })
  if (receipt.status !== 'success')
    throw new VerificationFailedError({
      reason: `${label} precompile transaction reverted: ${receipt.transactionHash}`,
    })
  return receipt
}

export type BroadcastOpenTransactionResult = {
  txHash: Hex
  descriptor: ChannelDescriptor
  state: ChannelState
  expiringNonceHash: Hex
  openDeposit: bigint
}

/** Broadcast and validate a client-signed TIP-1034 open transaction. */
export async function broadcastOpenTransaction(parameters: {
  challengeExpires?: string | undefined
  chainId: number
  client: TransactionClient
  escrowContract: Address
  expectedAuthorizedSigner: Address
  expectedChannelId: Hex
  expectedCurrency: Address
  expectedExpiringNonceHash: Hex
  expectedOperator: Address
  expectedPayee: Address
  expectedPayer: Address
  feePayer?: Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  serializedTransaction: Hex
  beforeBroadcast?:
    | ((result: Omit<BroadcastOpenTransactionResult, 'txHash' | 'state'>) => Promise<void> | void)
    | undefined
}): Promise<BroadcastOpenTransactionResult> {
  if (parameters.feePayer && !FeePayer.isTempoTransaction(parameters.serializedTransaction))
    throw new BadRequestError({ reason: 'Only Tempo (0x76/0x78) transactions are supported' })

  const transaction = Transaction.deserialize(
    parameters.serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls
  if (calls.length !== 1)
    throw new VerificationFailedError({
      reason: 'TIP-1034 open transaction must contain exactly one call',
    })
  const call = calls[0]!
  if (!call.to || !isAddressEqual(call.to, parameters.escrowContract))
    throw new VerificationFailedError({
      reason: 'TIP-1034 open transaction targets the wrong address',
    })
  const payer = transaction.from ?? parameters.expectedPayer
  const open = ChannelOps.parseOpenCall({
    data: call.data!,
    expected: {
      payee: parameters.expectedPayee,
      token: parameters.expectedCurrency,
      operator: parameters.expectedOperator,
      authorizedSigner: parameters.expectedAuthorizedSigner,
    },
  })
  const descriptor = ChannelOps.descriptorFromOpen({
    chainId: parameters.chainId,
    escrow: parameters.escrowContract,
    payer,
    open,
    expiringNonceHash: parameters.expectedExpiringNonceHash,
    channelId: parameters.expectedChannelId,
  })
  const expiringNonceHash = ChannelUtils.computeExpiringNonceHash(
    transaction as ChannelUtils.ExpiringNonceTransaction,
    { sender: payer },
  )
  if (expiringNonceHash.toLowerCase() !== descriptor.expiringNonceHash.toLowerCase())
    throw new VerificationFailedError({
      reason: 'credential expiringNonceHash does not match transaction',
    })
  await parameters.beforeBroadcast?.({
    descriptor,
    expiringNonceHash,
    openDeposit: open.deposit,
  })
  const receipt = await sendCredentialTransaction({
    challengeExpires: parameters.challengeExpires,
    chainId: parameters.chainId,
    client: parameters.client,
    details: {
      channelId: parameters.expectedChannelId,
      currency: parameters.expectedCurrency,
      recipient: parameters.expectedPayee,
    },
    expectedFeeToken: parameters.expectedCurrency,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    label: 'open',
    serializedTransaction: parameters.serializedTransaction,
    transaction,
  })
  const opened = getChannelEvent(receipt, 'ChannelOpened', parameters.expectedChannelId)
  const emittedChannelId = opened.args.channelId as Hex
  const emittedExpiringNonceHash = opened.args.expiringNonceHash as Hex
  const emittedDeposit = uint96(opened.args.deposit as bigint)
  if (emittedChannelId.toLowerCase() !== parameters.expectedChannelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'ChannelOpened channelId does not match credential',
    })
  if (emittedExpiringNonceHash.toLowerCase() !== descriptor.expiringNonceHash.toLowerCase())
    throw new VerificationFailedError({
      reason: 'ChannelOpened expiringNonceHash does not match descriptor',
    })
  if (emittedDeposit !== open.deposit)
    throw new VerificationFailedError({ reason: 'ChannelOpened deposit does not match calldata' })
  const confirmedChannelId = ChannelUtils.computeId({
    ...descriptor,
    chainId: parameters.chainId,
    escrow: parameters.escrowContract,
  })
  if (confirmedChannelId.toLowerCase() !== emittedChannelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'descriptor does not match ChannelOpened channelId',
    })
  const chainChannel = await getChannel(parameters.client, descriptor, parameters.escrowContract)
  const state = chainChannel.state
  if (state.deposit !== emittedDeposit || state.settled !== 0n || state.closeRequestedAt !== 0)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match open receipt',
    })
  return {
    txHash: receipt.transactionHash,
    descriptor,
    state,
    expiringNonceHash: emittedExpiringNonceHash,
    openDeposit: open.deposit,
  }
}

export type BroadcastTopUpTransactionResult = {
  txHash: Hex
  newDeposit: bigint
  state: ChannelState
}

/** Broadcast and validate a client-signed TIP-1034 top-up transaction. */
export async function broadcastTopUpTransaction(parameters: {
  additionalDeposit: bigint
  challengeExpires?: string | undefined
  chainId: number
  client: TransactionClient
  descriptor: ChannelDescriptor
  escrowContract: Address
  expectedCurrency: Address
  expectedChannelId: Hex
  feePayer?: Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  serializedTransaction: Hex
}): Promise<BroadcastTopUpTransactionResult> {
  if (parameters.feePayer && !FeePayer.isTempoTransaction(parameters.serializedTransaction))
    throw new BadRequestError({ reason: 'Only Tempo (0x76/0x78) transactions are supported' })

  const transaction = Transaction.deserialize(
    parameters.serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls
  if (calls.length !== 1)
    throw new VerificationFailedError({
      reason: 'TIP-1034 topUp transaction must contain exactly one call',
    })
  const call = calls[0]!
  if (!call.to || !isAddressEqual(call.to, parameters.escrowContract))
    throw new VerificationFailedError({
      reason: 'TIP-1034 topUp transaction targets the wrong address',
    })
  ChannelOps.parseTopUpCall({
    data: call.data!,
    expected: {
      descriptor: parameters.descriptor,
      additionalDeposit: parameters.additionalDeposit,
    },
  })
  const receipt = await sendCredentialTransaction({
    challengeExpires: parameters.challengeExpires,
    chainId: parameters.chainId,
    client: parameters.client,
    details: {
      additionalDeposit: parameters.additionalDeposit.toString(),
      channelId: parameters.expectedChannelId,
      currency: parameters.expectedCurrency,
    },
    expectedFeeToken: parameters.expectedCurrency,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    label: 'topUp',
    serializedTransaction: parameters.serializedTransaction,
    transaction,
  })
  const toppedUp = getChannelEvent(receipt, 'TopUp', parameters.expectedChannelId)
  const emittedChannelId = toppedUp.args.channelId as Hex
  const newDeposit = uint96(toppedUp.args.newDeposit as bigint)
  if (emittedChannelId.toLowerCase() !== parameters.expectedChannelId.toLowerCase())
    throw new VerificationFailedError({ reason: 'TopUp channelId does not match credential' })
  const state = await getChannelState(
    parameters.client,
    emittedChannelId,
    parameters.escrowContract,
  )
  if (state.deposit !== newDeposit)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match topUp receipt',
    })
  return { txHash: receipt.transactionHash, newDeposit, state }
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

  return sendViemTransaction(client, {
    ...(options?.account ? { account: options.account } : {}),
    to,
    data,
    ...(options?.feeToken ? { feeToken: options.feeToken } : {}),
  } as never)
}
