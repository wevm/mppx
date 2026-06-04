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

import { BadRequestError, VerificationFailedError } from '../../../Errors.js'
import * as FeePayer from '../../internal/fee-payer.js'
import { resolveFeeToken } from '../../internal/fee-token.js'
import * as ChannelOps from '../server/ChannelOps.js'
import * as ChannelUtils from './Channel.js'
import type { ChannelDescriptor } from './Channel.js'
import { escrowAbi } from './escrow.abi.js'
import { tip20ChannelEscrow } from './Protocol.js'

/** Minimal on-chain state read back after precompile transaction receipts. */
export type ReceiptValidationChannelState = {
  /** Cumulative amount settled on-chain. */
  settled: bigint
  /** Current on-chain channel deposit. */
  deposit: bigint
  /** Close-request timestamp, or zero when open. */
  closeRequestedAt: number
}

/** Inputs used to validate a ChannelOpened event against the verified open calldata. */
export type ValidateChannelOpenedReceiptParameters = {
  /** Chain ID used in descriptor-derived channel ID. */
  chainId: number
  /** Descriptor reconstructed from the open calldata. */
  descriptor: ChannelDescriptor
  /** Channel ID emitted by the ChannelOpened event. */
  emittedChannelId: Hex
  /** Deposit emitted by the ChannelOpened event. */
  emittedDeposit: bigint
  /** Expiring nonce hash emitted by the ChannelOpened event. */
  emittedExpiringNonceHash: Hex
  /** Escrow precompile address used in descriptor-derived channel ID. */
  escrow: Address
  /** Channel ID expected from the credential. */
  expectedChannelId: Hex
  /** Deposit parsed from open calldata. */
  openDeposit: bigint
}

/** Inputs used to validate open read-back state after ChannelOpened. */
export type ValidateOpenReadbackStateParameters = {
  /** Deposit emitted by the ChannelOpened event. */
  emittedDeposit: bigint
  /** State read back from the precompile. */
  state: ReceiptValidationChannelState
}

/** Inputs used to validate a TopUp event against the credential channel ID. */
export type ValidateTopUpReceiptParameters = {
  /** Channel ID emitted by the TopUp event. */
  emittedChannelId: Hex
  /** Channel ID expected from the credential. */
  expectedChannelId: Hex
}

/** Inputs used to validate top-up read-back state after TopUp. */
export type ValidateTopUpReadbackStateParameters = {
  /** New deposit emitted by the TopUp event. */
  newDeposit: bigint
  /** State read back from the precompile. */
  state: ReceiptValidationChannelState
}

/** Typed fields decoded from a ChannelOpened receipt event. */
export type ChannelOpenedReceiptFields = {
  /** Channel ID emitted by the precompile. */
  channelId: Hex
  /** Deposit emitted by the precompile. */
  deposit: bigint
  /** Expiring nonce hash emitted by the precompile. */
  expiringNonceHash: Hex
}

/** Typed fields decoded from a TopUp receipt event. */
export type TopUpReceiptFields = {
  /** Channel ID emitted by the precompile. */
  channelId: Hex
  /** New total deposit emitted by the precompile. */
  newDeposit: bigint
}

/** Typed fields decoded from a Settled receipt event. */
export type SettledReceiptFields = {
  /** New cumulative amount settled on-chain. */
  newSettled: bigint
}

/** Typed fields decoded from a ChannelClosed receipt event. */
export type ChannelClosedReceiptFields = {
  /** Amount captured by the payee. */
  settledToPayee: bigint
  /** Amount refunded to the payer. */
  refundedToPayer: bigint
}

type ReceiptEventWithArgs = {
  args: Record<string, unknown>
}

const uint96Max = 2n ** 96n - 1n

function readBytes32(value: unknown, label: string): Hex {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) return value as Hex
  throw new VerificationFailedError({ reason: `${label} missing from receipt event` })
}

function readUint96(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint')
    throw new VerificationFailedError({ reason: `${label} missing from receipt event` })
  if (value < 0n || value > uint96Max)
    throw new VerificationFailedError({ reason: `${label} exceeds uint96 range` })
  return value
}

/** Reads and validates typed fields from a ChannelOpened receipt event. */
export function readChannelOpenedReceiptFields(
  event: ReceiptEventWithArgs,
): ChannelOpenedReceiptFields {
  return {
    channelId: readBytes32(event.args.channelId, 'ChannelOpened channelId'),
    deposit: readUint96(event.args.deposit, 'ChannelOpened deposit'),
    expiringNonceHash: readBytes32(event.args.expiringNonceHash, 'ChannelOpened expiringNonceHash'),
  }
}

/** Reads and validates typed fields from a TopUp receipt event. */
export function readTopUpReceiptFields(event: ReceiptEventWithArgs): TopUpReceiptFields {
  return {
    channelId: readBytes32(event.args.channelId, 'TopUp channelId'),
    newDeposit: readUint96(event.args.newDeposit, 'TopUp newDeposit'),
  }
}

/** Reads and validates typed fields from a Settled receipt event. */
export function readSettledReceiptFields(event: ReceiptEventWithArgs): SettledReceiptFields {
  return {
    newSettled: readUint96(event.args.newSettled, 'Settled newSettled'),
  }
}

/** Reads and validates typed fields from a ChannelClosed receipt event. */
export function readChannelClosedReceiptFields(
  event: ReceiptEventWithArgs,
): ChannelClosedReceiptFields {
  return {
    settledToPayee: readUint96(event.args.settledToPayee, 'ChannelClosed settledToPayee'),
    refundedToPayer: readUint96(event.args.refundedToPayer, 'ChannelClosed refundedToPayer'),
  }
}

/** Validates that ChannelOpened receipt fields match calldata, descriptor, and credential. */
export function validateChannelOpenedReceipt(
  parameters: ValidateChannelOpenedReceiptParameters,
): void {
  const {
    chainId,
    descriptor,
    emittedChannelId,
    emittedDeposit,
    emittedExpiringNonceHash,
    escrow,
    expectedChannelId,
    openDeposit,
  } = parameters

  if (emittedChannelId.toLowerCase() !== expectedChannelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'ChannelOpened channelId does not match credential',
    })
  if (emittedExpiringNonceHash.toLowerCase() !== descriptor.expiringNonceHash.toLowerCase())
    throw new VerificationFailedError({
      reason: 'ChannelOpened expiringNonceHash does not match descriptor',
    })
  if (emittedDeposit !== openDeposit)
    throw new VerificationFailedError({ reason: 'ChannelOpened deposit does not match calldata' })

  const confirmedChannelId = ChannelUtils.computeId({ ...descriptor, chainId, escrow })
  if (confirmedChannelId.toLowerCase() !== emittedChannelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'descriptor does not match ChannelOpened channelId',
    })
}

/** Validates the state read back after a successful open transaction. */
export function validateOpenReadbackState(parameters: ValidateOpenReadbackStateParameters): void {
  const { emittedDeposit, state } = parameters
  if (state.deposit !== emittedDeposit || state.settled !== 0n || state.closeRequestedAt !== 0)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match open receipt',
    })
}

/** Validates that a TopUp receipt belongs to the credential channel. */
export function validateTopUpReceipt(parameters: ValidateTopUpReceiptParameters): void {
  if (parameters.emittedChannelId.toLowerCase() !== parameters.expectedChannelId.toLowerCase())
    throw new VerificationFailedError({ reason: 'TopUp channelId does not match credential' })
}

/** Validates the state read back after a successful top-up transaction. */
export function validateTopUpReadbackState(parameters: ValidateTopUpReadbackStateParameters): void {
  if (parameters.state.deposit !== parameters.newDeposit)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match topUp receipt',
    })
}

/** Fee fields produced by viem transaction preparation for direct precompile calls. */
export type PreparedPrecompileFeePayerTransaction = {
  /** Estimated gas units for the transaction. */
  gas?: bigint | undefined
  /** Maximum fee per gas unit. */
  maxFeePerGas?: bigint | undefined
  /** Maximum priority fee per gas unit. */
  maxPriorityFeePerGas?: bigint | undefined
}

/** Parameters for checking a direct precompile transaction against sponsor limits. */
export type AssertPrecompileFeePayerPolicyParameters = {
  /** Prepared transaction fee fields to validate. */
  prepared: PreparedPrecompileFeePayerTransaction
  /** Optional sponsor policy overrides. Missing fields are not enforced here. */
  policy?: Partial<FeePayer.Policy> | undefined
}

/** Enforces sponsor gas and fee limits before co-signing a direct precompile call. */
export function assertPrecompileFeePayerPolicy(
  parameters: AssertPrecompileFeePayerPolicyParameters,
) {
  const { policy, prepared } = parameters
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

const UINT96_MAX = 2n ** 96n - 1n

/** viem client shape accepted by raw Tempo transaction actions. */
export type TransactionClient = Parameters<typeof sendRawTransaction>[0]

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

/** Options accepted by low-level TIP-1034 on-chain management helpers. */
export type ChannelTransactionOptions = {
  /** Account used to send the transaction when the viem client has no default account. */
  account?: Account | undefined
  /** Candidate fee tokens used when resolving a fee token for fee-sponsored transactions. */
  candidateFeeTokens?: readonly Address[] | undefined
  /** Fee-payer account used to co-sign Tempo fee-sponsored transactions. */
  feePayer?: Account | undefined
  /** Optional fee-payer gas and total-fee limits enforced before co-signing. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Explicit fee token for the transaction. */
  feeToken?: Address | undefined
}

type ParsedPrecompileCredentialTransaction = {
  call: Transaction.TransactionTempo['calls'][number] & { data: Hex; to: Address }
  transaction: ReturnType<(typeof Transaction)['deserialize']>
}

function parsePrecompileCredentialTransaction(parameters: {
  escrowContract: Address
  feePayer?: Account | undefined
  label: 'open' | 'topUp'
  serializedTransaction: Hex
}): ParsedPrecompileCredentialTransaction {
  const { escrowContract, feePayer, label, serializedTransaction } = parameters
  if (feePayer && !FeePayer.isTempoTransaction(serializedTransaction))
    throw new BadRequestError({ reason: 'Only Tempo (0x76/0x78) transactions are supported' })

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls
  if (calls.length !== 1)
    throw new VerificationFailedError({
      reason: `TIP-1034 ${label} transaction must contain exactly one call`,
    })
  const call = calls[0]!
  if (!call.to || !isAddressEqual(call.to, escrowContract))
    throw new VerificationFailedError({
      reason: `TIP-1034 ${label} transaction targets the wrong address`,
    })
  if (!call.data)
    throw new VerificationFailedError({
      reason: `TIP-1034 ${label} transaction is missing calldata`,
    })
  return { transaction, call: { ...call, data: call.data, to: call.to } }
}

async function simulateTempoTransaction(client: Client, transaction: Transaction.TransactionTempo) {
  // viem's public `call` type does not yet model Tempo's multi-call and
  // fee-payer fields together. Keep that compatibility cast in one place.
  await call(client, {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls ?? [],
    feePayerSignature: undefined,
  } as never)
}

async function signTempoTransaction(client: Client, transaction: unknown): Promise<Hex> {
  return (await signTransaction(client, transaction as never)) as Hex
}

async function prepareFeePayerCallTransaction(
  client: Client,
  parameters: {
    account: Account
    data: Hex
    feeToken?: Address | undefined
    to: Address
  },
) {
  const { account, data, feeToken, to } = parameters
  // viem's stable request type does not expose Tempo fee-payer transaction
  // fields for this call shape. Keep the cast at the boundary.
  return prepareTransactionRequest(client, {
    account,
    calls: [{ to, data }],
    feePayer: true,
    ...(feeToken ? { feeToken } : {}),
  } as never)
}

function sendPrecompileContractCall(
  client: Client,
  parameters: {
    account?: Account | undefined
    data: Hex
    feeToken?: Address | undefined
    to: Address
  },
): Promise<Hex> {
  const { account, data, feeToken, to } = parameters
  // `feeToken` is Tempo-specific and not represented on viem's base
  // transaction request type.
  return sendViemTransaction(client, {
    ...(account ? { account } : {}),
    to,
    data,
    ...(feeToken ? { feeToken } : {}),
  } as never)
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
  options?: ChannelTransactionOptions,
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
  options?: ChannelTransactionOptions,
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
  options?: ChannelTransactionOptions,
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
  options?: ChannelTransactionOptions,
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
  options?: ChannelTransactionOptions,
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

/** Receipt-like input used when extracting channel events from transaction logs. */
export type ChannelEventReceipt = {
  logs: Parameters<typeof parseEventLogs>[0]['logs']
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
  receipt: ChannelEventReceipt,
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

/** Inputs for broadcasting a client-signed precompile management transaction. */
export type SendCredentialTransactionParameters = {
  /** Challenge expiration propagated into fee-payer policy checks. */
  challengeExpires?: string | undefined
  /** Chain ID used for fee-payer transaction signing. */
  chainId: number
  /** viem client used to submit the transaction. */
  client: TransactionClient
  /** Human-readable transaction details used by fee-payer policy hooks. */
  details: Record<string, string>
  /** Fee token expected by the server for sponsored transactions. */
  expectedFeeToken?: Address | undefined
  /** Fee-payer account used to co-sign Tempo transactions. */
  feePayer?: Account | undefined
  /** Optional fee-payer policy enforced before co-signing. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Management transaction kind, used for validation errors. */
  label: 'open' | 'topUp'
  /** Client-signed serialized transaction. */
  serializedTransaction: Hex
  /** Deserialized transaction corresponding to `serializedTransaction`. */
  transaction: ReturnType<(typeof Transaction)['deserialize']>
}

/** Broadcasts a client-signed management transaction, adding a fee-payer co-signature when requested. */
export async function sendCredentialTransaction(parameters: SendCredentialTransactionParameters) {
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

  await simulateTempoTransaction(client, transaction)

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
  const serialized = await signTempoTransaction(client, sponsored)
  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: serialized as Transaction.TransactionSerializedTempo,
  })
  if (receipt.status !== 'success')
    throw new VerificationFailedError({
      reason: `${label} precompile transaction reverted: ${receipt.transactionHash}`,
    })
  return receipt
}

/** Result returned after a TIP-1034 open transaction is broadcast and verified. */
export type BroadcastOpenTransactionResult = {
  /** Broadcast transaction hash. */
  txHash: Hex
  /** Descriptor recovered from the verified open transaction. */
  descriptor: ChannelDescriptor
  /** Latest on-chain channel state after open. */
  state: ChannelState
  /** Expiring nonce hash emitted by the open receipt. */
  expiringNonceHash: Hex
  /** Deposit amount encoded in the open calldata. */
  openDeposit: bigint
}

/** Inputs for broadcasting and verifying a client-signed TIP-1034 open transaction. */
export type BroadcastOpenTransactionParameters = {
  /** Hook invoked after calldata validation but before broadcasting. */
  beforeBroadcast?:
    | ((result: Omit<BroadcastOpenTransactionResult, 'txHash' | 'state'>) => Promise<void> | void)
    | undefined
  /** Challenge expiration propagated into fee-payer policy checks. */
  challengeExpires?: string | undefined
  /** Chain ID used for channel ID and voucher domain separation. */
  chainId: number
  /** viem client used for transaction submission and readback. */
  client: TransactionClient
  /** TIP20EscrowChannel precompile address. */
  escrowContract: Address
  /** Authorized voucher signer expected in the open calldata. */
  expectedAuthorizedSigner: Address
  /** Channel ID expected from descriptor, escrow, and chain ID. */
  expectedChannelId: Hex
  /** Payment token expected in the open calldata. */
  expectedCurrency: Address
  /** Transaction-bound nonce hash expected in the descriptor. */
  expectedExpiringNonceHash: Hex
  /** Payee-side operator expected in the open calldata. */
  expectedOperator: Address
  /** Payment recipient expected in the open calldata. */
  expectedPayee: Address
  /** Payer expected to have signed the open transaction. */
  expectedPayer: Address
  /** Fee-payer account used to co-sign sponsored open transactions. */
  feePayer?: Account | undefined
  /** Optional fee-payer policy enforced before co-signing. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Client-signed serialized open transaction. */
  serializedTransaction: Hex
}

/** Broadcast and validate a client-signed TIP-1034 open transaction. */
export async function broadcastOpenTransaction(
  parameters: BroadcastOpenTransactionParameters,
): Promise<BroadcastOpenTransactionResult> {
  const { transaction, call } = parsePrecompileCredentialTransaction({
    escrowContract: parameters.escrowContract,
    feePayer: parameters.feePayer,
    label: 'open',
    serializedTransaction: parameters.serializedTransaction,
  })
  const payer = transaction.from ?? parameters.expectedPayer
  const open = ChannelOps.parseOpenCall({
    data: call.data,
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
  if (parameters.feePayer) assertSenderSigned(transaction)
  const expiringNonceHash = ChannelUtils.computeExpiringNonceHash(
    ChannelUtils.transactionForExpiringNonceHash({
      feePayer: parameters.feePayer,
      transaction,
    }),
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
  const opened = readChannelOpenedReceiptFields(
    getChannelEvent(receipt, 'ChannelOpened', parameters.expectedChannelId),
  )
  validateChannelOpenedReceipt({
    chainId: parameters.chainId,
    descriptor,
    emittedChannelId: opened.channelId,
    emittedDeposit: opened.deposit,
    emittedExpiringNonceHash: opened.expiringNonceHash,
    escrow: parameters.escrowContract,
    expectedChannelId: parameters.expectedChannelId,
    openDeposit: open.deposit,
  })
  const chainChannel = await getChannel(parameters.client, descriptor, parameters.escrowContract)
  const state = chainChannel.state
  validateOpenReadbackState({ emittedDeposit: opened.deposit, state })
  return {
    txHash: receipt.transactionHash,
    descriptor,
    state,
    expiringNonceHash: opened.expiringNonceHash,
    openDeposit: open.deposit,
  }
}

/** Result returned after a TIP-1034 top-up transaction is broadcast and verified. */
export type BroadcastTopUpTransactionResult = {
  /** Broadcast transaction hash. */
  txHash: Hex
  /** New on-chain deposit emitted by the top-up receipt. */
  newDeposit: bigint
  /** Latest on-chain channel state after top-up. */
  state: ChannelState
}

/** Inputs for broadcasting and verifying a client-signed TIP-1034 top-up transaction. */
export type BroadcastTopUpTransactionParameters = {
  /** Additional deposit amount expected in the top-up calldata. */
  additionalDeposit: bigint
  /** Challenge expiration propagated into fee-payer policy checks. */
  challengeExpires?: string | undefined
  /** Chain ID used for fee-payer transaction signing. */
  chainId: number
  /** viem client used for transaction submission and readback. */
  client: TransactionClient
  /** Descriptor expected in the top-up calldata. */
  descriptor: ChannelDescriptor
  /** TIP20EscrowChannel precompile address. */
  escrowContract: Address
  /** Channel ID expected in the top-up receipt. */
  expectedChannelId: Hex
  /** Payment token expected for sponsored transaction fee token checks. */
  expectedCurrency: Address
  /** Fee-payer account used to co-sign sponsored top-up transactions. */
  feePayer?: Account | undefined
  /** Optional fee-payer policy enforced before co-signing. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Client-signed serialized top-up transaction. */
  serializedTransaction: Hex
}

/** Broadcast and validate a client-signed TIP-1034 top-up transaction. */
export async function broadcastTopUpTransaction(
  parameters: BroadcastTopUpTransactionParameters,
): Promise<BroadcastTopUpTransactionResult> {
  const { transaction, call } = parsePrecompileCredentialTransaction({
    escrowContract: parameters.escrowContract,
    feePayer: parameters.feePayer,
    label: 'topUp',
    serializedTransaction: parameters.serializedTransaction,
  })
  ChannelOps.parseTopUpCall({
    data: call.data,
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
  const toppedUp = readTopUpReceiptFields(
    getChannelEvent(receipt, 'TopUp', parameters.expectedChannelId),
  )
  validateTopUpReceipt({
    emittedChannelId: toppedUp.channelId,
    expectedChannelId: parameters.expectedChannelId,
  })
  const state = await getChannelState(
    parameters.client,
    toppedUp.channelId,
    parameters.escrowContract,
  )
  validateTopUpReadbackState({ newDeposit: toppedUp.newDeposit, state })
  return { txHash: receipt.transactionHash, newDeposit: toppedUp.newDeposit, state }
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

async function sendPrecompileTransaction(
  client: Client,
  to: Address,
  data: Hex,
  label: string,
  options?: ChannelTransactionOptions,
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
    const prepared = await prepareFeePayerCallTransaction(client, {
      account,
      data,
      feeToken,
      to,
    })
    assertPrecompileFeePayerPolicy({ prepared, policy: options.feePayerPolicy })
    const serialized = await signTempoTransaction(client, {
      ...prepared,
      account,
      feePayer: options.feePayer,
    })
    const receipt = await sendRawTransactionSync(client, {
      serializedTransaction: serialized as Transaction.TransactionSerializedTempo,
    })
    if (receipt.status !== 'success')
      throw new VerificationFailedError({
        reason: `${label} precompile transaction reverted: ${receipt.transactionHash}`,
      })
    return receipt.transactionHash
  }

  return sendPrecompileContractCall(client, {
    account: options?.account,
    to,
    data,
    feeToken: options?.feeToken,
  })
}
