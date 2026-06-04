import {
  isAddress,
  isAddressEqual,
  parseUnits,
  zeroAddress,
  type Account as viem_Account,
  type Address,
  type Hex,
} from 'viem'

import type * as Credential from '../../../Credential.js'
import {
  BadRequestError,
  ChannelClosedError,
  ChannelNotFoundError,
  InsufficientBalanceError,
  VerificationFailedError,
} from '../../../Errors.js'
import type * as Method from '../../../Method.js'
import * as Store from '../../../Store.js'
import type * as FeePayer from '../../internal/fee-payer.js'
import { isSessionContentRequest } from '../../server/internal/request-body.js'
import * as Chain from '../precompile/Chain.js'
import { readSettledReceiptFields } from '../precompile/Chain.js'
import {
  uint96,
  type SessionCredentialPayload,
  type SessionReceipt,
} from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'

/** Fee-payer parameter accepted by the server session method. */
export type ParameterFeePayer = viem_Account | string | true | undefined

/** Minimum method details needed to decide credential-time fee sponsorship. */
export type CredentialFeePayerMethodDetails = {
  /** Whether the challenge advertised fee-payer support. */
  feePayer?: boolean | undefined
}

/** Inputs used to resolve request-time fee sponsorship policy. */
export type ResolveRequestFeePayerParameters = {
  /** Incoming credential, present for verification/management requests. */
  credential: Credential.Credential | null | undefined
  /** Default fee-payer account resolved from server parameters. */
  defaultFeePayer?: viem_Account | undefined
  /** Server-level fee-payer parameter. */
  parameterFeePayer?: ParameterFeePayer
  /** Per-request fee-payer override. */
  requestFeePayer?: boolean | viem_Account | undefined
}

/** Inputs used to resolve credential-time fee sponsorship account. */
export type ResolveCredentialFeePayerParameters = {
  /** Request object being verified. */
  request: unknown
  /** Challenge method details echoed by the credential. */
  methodDetails: CredentialFeePayerMethodDetails
  /** Default fee-payer account resolved from server parameters. */
  feePayer?: viem_Account | undefined
}

/** Fee-payer value read from an untrusted credential challenge request. */
export type RequestFeePayerValue = boolean | viem_Account | undefined

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAccount(value: unknown): value is viem_Account {
  return isObject(value) && typeof value.address === 'string' && isAddress(value.address)
}

/** Reads the optional `feePayer` field from an untrusted request object. */
export function readRequestFeePayer(value: unknown): RequestFeePayerValue {
  if (!isObject(value)) return undefined
  const feePayer = value.feePayer
  if (feePayer === undefined || typeof feePayer === 'boolean') return feePayer
  if (isAccount(feePayer)) return feePayer
  return undefined
}

/** Resolves whether a challenge should advertise fee sponsorship or a credential can use it. */
export function resolveRequestFeePayer(
  parameters: ResolveRequestFeePayerParameters,
): boolean | viem_Account | undefined {
  const { credential, defaultFeePayer, parameterFeePayer, requestFeePayer } = parameters
  if (requestFeePayer === false) return credential ? false : undefined

  const account = typeof requestFeePayer === 'object' ? requestFeePayer : defaultFeePayer
  if (credential) return account ?? undefined
  if (account || defaultFeePayer || parameterFeePayer === true) return true
  return undefined
}

/** Resolves the fee-payer account allowed for an incoming credential. */
export function resolveCredentialFeePayer(
  parameters: ResolveCredentialFeePayerParameters,
): viem_Account | undefined {
  const { feePayer, methodDetails, request } = parameters
  const requestFeePayer = readRequestFeePayer(request)
  const requestAllowsFeePayer =
    requestFeePayer === undefined || requestFeePayer === true || typeof requestFeePayer === 'object'
  if (methodDetails.feePayer !== true || !requestAllowsFeePayer) return undefined
  return typeof requestFeePayer === 'object' ? requestFeePayer : feePayer
}

/** Declarative server-side settlement cadence for automatic session settlement. */
export type SettlementSchedule = {
  /** Settle after this many additional paid units since the previous scheduled settlement. */
  units?: number | undefined
  /** Settle after this much additional settlement amount since the previous scheduled settlement. */
  amount?: string | bigint | undefined
  /** Settle after this many milliseconds since the previous scheduled settlement. */
  intervalMs?: number | undefined
}

/** Settlement schedule normalized into raw token units. */
export type ResolvedSettlementSchedule = {
  /** Raw token amount threshold. */
  amount?: bigint | undefined
  /** Elapsed-time threshold since previous settlement. */
  intervalMs?: number | undefined
  /** Paid unit threshold. */
  units?: number | undefined
}

/** Progress counters compared against a server-owned settlement schedule. */
export type SettlementProgress = {
  /** Additional raw spend since the previous scheduled settlement boundary. */
  amount: bigint
  /** Milliseconds elapsed since the previous scheduled settlement boundary. */
  elapsedMs?: number | undefined
  /** Additional paid units since the previous scheduled settlement boundary. */
  units: number
}

/** Inputs used to mark a channel after automatic scheduled settlement succeeds. */
export type MarkSettlementCompleteParameters = {
  channelId: ChannelStore.State['channelId']
  settledAt?: string | undefined
  store: ChannelStore.ChannelStore
}

/** Converts a public settlement schedule into raw-unit thresholds. */
export function resolveSettlementSchedule(
  schedule: SettlementSchedule | undefined,
  decimals: number,
): ResolvedSettlementSchedule | undefined {
  if (!schedule) return undefined
  return {
    ...(schedule.amount !== undefined && {
      amount:
        typeof schedule.amount === 'bigint'
          ? schedule.amount
          : parseUnits(schedule.amount, decimals),
    }),
    ...(schedule.intervalMs !== undefined && { intervalMs: schedule.intervalMs }),
    ...(schedule.units !== undefined && { units: schedule.units }),
  }
}

/**
 * Computes the schedule progress for an unsettled precompile-backed channel.
 *
 * Returns `undefined` for channels that cannot be scheduled: non-precompile
 * records, channels without an accepted voucher, or channels with no unsettled
 * voucher amount.
 */
export function resolveSettlementProgress(
  channel: ChannelStore.State,
): SettlementProgress | undefined {
  if (!ChannelStore.isPrecompileState(channel)) return undefined
  if (!channel.highestVoucher) return undefined
  if (channel.highestVoucher.cumulativeAmount <= channel.settledOnChain) return undefined

  const amountBoundary = channel.lastSettlementSpent ?? channel.settledOnChain
  const timestampBoundary = Date.parse(channel.lastSettlementAt ?? channel.createdAt)

  return {
    amount: channel.spent - amountBoundary,
    ...(Number.isFinite(timestampBoundary) && {
      elapsedMs: Date.now() - timestampBoundary,
    }),
    units: channel.units - (channel.lastSettlementUnits ?? 0),
  }
}

/** Returns whether the precompile channel has crossed any configured settlement threshold. */
export function isSettlementDue(
  channel: ChannelStore.State,
  schedule: ResolvedSettlementSchedule | undefined,
): boolean {
  if (!schedule) return false
  const progress = resolveSettlementProgress(channel)
  if (!progress) return false

  if (schedule.units !== undefined && progress.units >= schedule.units) return true

  if (schedule.amount !== undefined && progress.amount >= schedule.amount) return true

  if (schedule.intervalMs !== undefined && (progress.elapsedMs ?? 0) >= schedule.intervalMs)
    return true

  return false
}

/** Records the channel spend/unit counters that a scheduled settlement captured. */
export async function markSettlementComplete(parameters: MarkSettlementCompleteParameters) {
  const { channelId, store, settledAt = new Date().toISOString() } = parameters
  await store.updateChannel(channelId, (current) =>
    current
      ? {
          ...current,
          lastSettlementAt: settledAt,
          lastSettlementSpent: current.spent,
          lastSettlementUnits: current.units,
        }
      : current,
  )
}

/** Callback used by post-verification accounting to deduct spend from a channel. */
export type ChargeSessionChannel = (channelId: Hex, amount: bigint) => Promise<ChannelStore.State>

/** Callback used by post-verification accounting to run server-owned settlement policy. */
export type SettleChargedSessionChannel = (channel: ChannelStore.State) => Promise<Hex | undefined>

/** Inputs for charging a precompile-backed session channel. */
export type ChargeParameters = {
  /** Server-side channel store. */
  store: ChannelStore.ChannelStore
  /** Channel ID to deduct from. */
  channelId: Hex
  /** Raw token amount to charge. */
  amount: bigint
}

/** Inputs used to apply default HTTP request/response accounting after credential verification. */
export type ApplyVerifiedHttpAccountingParameters = {
  /** Captured request metadata from the verified envelope, when this is a request-backed flow. */
  capturedRequest?: Method.CapturedRequest | undefined
  /** Deducts the configured request amount from channel spend. */
  charge: ChargeSessionChannel
  /** Returns the raw request amount to deduct for one content response. Called only when charging. */
  getRequestAmount: () => bigint
  /** Credential action that produced the receipt. Only open/voucher can pay for content. */
  payloadAction: SessionCredentialPayload['action']
  /** Receipt returned by credential verification before content accounting. */
  receipt: SessionReceipt
  /** Whether SSE transport is enabled. SSE accounting is stream-driven, not HTTP-response-driven. */
  sseEnabled: boolean
  /** Runs optional server settlement policy after a successful content charge. */
  settleCharged: SettleChargedSessionChannel
}

/** Applies the default HTTP content charge after a session credential has been accepted. */
export async function applyVerifiedHttpAccounting(
  parameters: ApplyVerifiedHttpAccountingParameters,
): Promise<SessionReceipt> {
  const { capturedRequest, payloadAction, receipt, sseEnabled } = parameters
  if (!capturedRequest || sseEnabled) return receipt
  if (!isSessionContentRequest(capturedRequest)) return receipt
  if (payloadAction !== 'open' && payloadAction !== 'voucher') return receipt

  const requestAmount = parameters.getRequestAmount()
  const charged = await parameters.charge(receipt.channelId, requestAmount)
  const settlementTxHash = await parameters.settleCharged(charged)
  return {
    ...receipt,
    spent: charged.spent.toString(),
    units: charged.units,
    ...(settlementTxHash ? { txHash: settlementTxHash } : {}),
  }
}

/** Atomically deducts spend from a channel and maps store failures to typed session errors. */
export async function chargeSessionChannel(
  parameters: ChargeParameters,
): Promise<ChannelStore.State> {
  const { store, channelId, amount } = parameters
  let result: Awaited<ReturnType<typeof ChannelStore.deductFromChannel>>
  try {
    result = await ChannelStore.deductFromChannel(store, channelId, amount)
  } catch {
    throw new ChannelClosedError({ reason: 'channel not found' })
  }
  if (!result.ok) {
    if (result.channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
    if (result.channel.closeRequestedAt !== 0n)
      throw new ChannelClosedError({ reason: 'channel has a pending close request' })
    const available = result.channel.highestVoucherAmount - result.channel.spent
    throw new InsufficientBalanceError({
      reason: `requested ${amount}, available ${available}`,
    })
  }
  return result.channel
}

/** Store accepted by public settlement controls. */
export type SessionStoreInput = Store.Store | ChannelStore.ChannelStore

/** Inputs used to validate who may submit payee-side settlement transactions. */
export type SettlementSenderParameters = {
  channelId: Hex
  operation: 'close' | 'settle'
  operator: Address
  payee: Address
  sender: Address | undefined
}

/** Options for server-driven precompile settlement transactions. */
export type SettlementTransactionOptions = {
  /** Account used to send the settlement transaction. Defaults to the viem client account. */
  account?: viem_Account | undefined
  /** Candidate fee tokens for sponsored settlement. Defaults to the channel token. */
  candidateFeeTokens?: readonly Address[] | undefined
  /** TIP20EscrowChannel precompile address override. */
  escrowContract?: Address | undefined
  /** Optional fee-payer account for sponsored settlement. */
  feePayer?: viem_Account | undefined
  /** Optional policy for sponsored settlement. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Optional fee token override for settlement. */
  feeToken?: Address | undefined
}

/** Inputs for applying a server-owned automatic settlement schedule. */
export type MaybeSettleScheduledParameters = {
  /** Account used to send the settlement transaction. */
  account?: viem_Account | undefined
  /** Channel that was just charged. */
  channel: ChannelStore.State
  /** viem client used to settle on-chain. */
  client: Chain.TransactionClient
  /** Optional fee-payer account for sponsored settlement. */
  feePayer?: viem_Account | undefined
  /** Optional policy for sponsored settlement. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Optional fee token override for settlement. */
  feeToken?: Address | undefined
  /** Resolved server-owned settlement cadence. */
  schedule: ResolvedSettlementSchedule | undefined
  /** Server-side channel store. */
  store: ChannelStore.ChannelStore
}

/** Resolves either a generic mppx store or an already-wrapped channel store. */
export function resolveChannelStore(store: SessionStoreInput): ChannelStore.ChannelStore {
  return 'getChannel' in store ? store : ChannelStore.fromStore(store)
}

/** Returns the account attached to a viem client, when one exists. */
export function getClientAccount(client: { account?: viem_Account | undefined }) {
  return client.account
}

/** Validates that the transaction sender is the channel payee or nonzero operator. */
export function assertSettlementSender(parameters: SettlementSenderParameters) {
  const { operation, channelId, operator, payee, sender } = parameters
  if (!sender)
    throw new Error(
      `Cannot ${operation} precompile channel ${channelId}: no account available. Pass an account override, or provide a getClient() that returns an account-bearing client.`,
    )
  if (isAddressEqual(sender, payee)) return
  if (!isAddressEqual(operator, zeroAddress) && isAddressEqual(sender, operator)) return
  throw new BadRequestError({
    reason:
      `Cannot ${operation} precompile channel ${channelId}: tx sender ${sender} is not the channel payee ${payee}` +
      (isAddressEqual(operator, zeroAddress) ? '.' : ` or operator ${operator}.`) +
      ' If using an access key, pass a Tempo access-key account whose address is the payee/operator wallet, not the raw delegated key address.',
  })
}

/** Applies automatic settlement when the server-owned schedule is due. */
export async function maybeSettleScheduled(
  parameters: MaybeSettleScheduledParameters,
): Promise<Hex | undefined> {
  const { channel, schedule, store } = parameters
  if (!isSettlementDue(channel, schedule)) return undefined
  const txHash = await settle(store, parameters.client, channel.channelId, {
    account: parameters.account,
    ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
    ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
    ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
  })
  await markSettlementComplete({ channelId: channel.channelId, store })
  return txHash
}

/** Settles the highest accepted voucher for a precompile-backed session channel. */
export async function settle(
  store_: SessionStoreInput,
  client: Chain.TransactionClient,
  channelId_: Hex,
  options?: SettlementTransactionOptions,
): Promise<Hex> {
  const store = resolveChannelStore(store_)
  const channelId = ChannelStore.normalizeChannelId(channelId_)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (!channel.highestVoucher) throw new VerificationFailedError({ reason: 'no voucher to settle' })
  const escrow = options?.escrowContract ?? channel.escrowContract
  const account = options?.account ?? getClientAccount(client)
  assertSettlementSender({
    operation: 'settle',
    channelId,
    operator: channel.operator,
    payee: channel.payee,
    sender: account?.address,
  })
  const amount = uint96(channel.highestVoucher.cumulativeAmount)
  const txHash = await Chain.settleOnChain(
    client,
    channel.descriptor,
    amount,
    channel.highestVoucher.signature,
    escrow,
    account
      ? {
          account,
          ...(options?.feePayer ? { feePayer: options.feePayer } : {}),
          ...(options?.feePayerPolicy ? { feePayerPolicy: options.feePayerPolicy } : {}),
          ...(options?.feeToken ? { feeToken: options.feeToken } : {}),
          candidateFeeTokens: options?.candidateFeeTokens ?? [channel.token],
        }
      : undefined,
  )
  const receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
  const settled = readSettledReceiptFields(Chain.getChannelEvent(receipt, 'Settled', channelId))
  const { newSettled } = settled
  if (newSettled < amount)
    throw new VerificationFailedError({ reason: 'Settled event is below voucher amount' })
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (state.settled !== newSettled)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match settle receipt',
    })
  await store.updateChannel(channelId, (current) =>
    current
      ? {
          ...current,
          settledOnChain: newSettled > current.settledOnChain ? newSettled : current.settledOnChain,
          lastSettlementAt: new Date().toISOString(),
          lastSettlementSpent: current.spent,
          lastSettlementUnits: current.units,
        }
      : current,
  )
  return txHash
}

/** Settles multiple precompile-backed session channels with the same validation as {@link settle}. */
export async function settleBatch(
  store: SessionStoreInput,
  client: Chain.TransactionClient,
  channelIds: readonly Hex[],
  options?: SettlementTransactionOptions,
): Promise<Hex[]> {
  const hashes: Hex[] = []
  for (const channelId of channelIds) hashes.push(await settle(store, client, channelId, options))
  return hashes
}
