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
import type { MaybePromise } from '../../../internal/types.js'
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

/** Resolved fee-payer mode for credential-time transaction submission. */
export type ResolvedFeePayer = viem_Account | true | undefined

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
  /** Configured local fee payer, hosted relay URL, or sponsorship flag. */
  feePayer?: ParameterFeePayer
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
  const hosted = parameterFeePayer === true || typeof parameterFeePayer === 'string'
  if (credential) return account ?? (hosted ? true : undefined)
  if (account || hosted) return true
  return undefined
}

/** Resolves the fee-payer account allowed for an incoming credential. */
export function resolveCredentialFeePayer(
  parameters: ResolveCredentialFeePayerParameters,
): ResolvedFeePayer {
  const { feePayer, methodDetails, request } = parameters
  const requestFeePayer = readRequestFeePayer(request)
  const requestAllowsFeePayer =
    requestFeePayer === undefined || requestFeePayer === true || typeof requestFeePayer === 'object'
  if (methodDetails.feePayer !== true || !requestAllowsFeePayer) return undefined
  if (typeof requestFeePayer === 'object') return requestFeePayer
  if (typeof feePayer === 'object') return feePayer
  return feePayer === true || typeof feePayer === 'string' ? true : undefined
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

/** Context emitted when an on-chain settlement or close transaction is confirmed. */
export type SessionSettlementContext = Readonly<{
  /** On-chain transaction hash (or signature on Solana). */
  txHash: Hex
  /** Channel ID that was settled. */
  channelId: Hex
  /** The trigger that caused settlement. */
  trigger: 'settle' | 'close' | 'scheduled'
  /** Cumulative amount settled on-chain to the payee (raw token units). */
  amount: bigint
  /** Incremental amount settled in this transaction (raw token units). */
  delta: bigint
}>

/** Callback invoked after an on-chain settlement or close transaction is confirmed. */
export type OnSessionSettlement = (context: SessionSettlementContext) => MaybePromise<void>

/** Inputs used to mark a channel after automatic scheduled settlement succeeds. */
export type MarkSettlementCompleteParameters = {
  channelId: ChannelStore.State['channelId']
  leaseOwner: string
  settledAt?: string | undefined
  store: ChannelStore.ChannelStore
}

const scheduledSettlementLeaseMs = 5 * 60_000

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
  const { channelId, leaseOwner, store, settledAt = new Date().toISOString() } = parameters
  await store.updateChannel(channelId, (current) => {
    if (!current) return current
    if (current.scheduledSettlementLease?.owner !== leaseOwner) return current
    const { scheduledSettlementLease: _, ...channel } = current
    return {
      ...channel,
      lastSettlementAt: settledAt,
      lastSettlementSpent: current.spent,
      lastSettlementUnits: current.units,
    }
  })
}

/** Atomically claims one due scheduled settlement across server workers. */
export async function claimScheduledSettlement(parameters: {
  channelId: Hex
  leaseMs?: number | undefined
  schedule: ResolvedSettlementSchedule
  store: ChannelStore.ChannelStore
}): Promise<string | undefined> {
  const { channelId, leaseMs = scheduledSettlementLeaseMs, schedule, store } = parameters
  const now = Date.now()
  const owner = globalThis.crypto.randomUUID()
  let claimed = false
  await store.updateChannel(channelId, (current) => {
    claimed = false
    if (!current || !isSettlementDue(current, schedule)) return current
    const lease = current.scheduledSettlementLease
    if (lease && lease.expiresAt > now) return current
    claimed = true
    return {
      ...current,
      scheduledSettlementLease: { expiresAt: now + leaseMs, owner },
    }
  })
  return claimed ? owner : undefined
}

/** Extends an owned scheduled settlement lease while its transaction is in flight. */
export async function renewScheduledSettlement(parameters: {
  channelId: Hex
  leaseMs?: number | undefined
  leaseOwner: string
  store: ChannelStore.ChannelStore
}): Promise<void> {
  const { channelId, leaseMs = scheduledSettlementLeaseMs, leaseOwner, store } = parameters
  await store.updateChannel(channelId, (current) => {
    if (!current || current.scheduledSettlementLease?.owner !== leaseOwner) return current
    return {
      ...current,
      scheduledSettlementLease: { expiresAt: Date.now() + leaseMs, owner: leaseOwner },
    }
  })
}

/** Releases a scheduled settlement claim after a failed attempt. */
export async function releaseScheduledSettlement(parameters: {
  channelId: Hex
  leaseOwner: string
  store: ChannelStore.ChannelStore
}): Promise<void> {
  const { channelId, leaseOwner, store } = parameters
  await store.updateChannel(channelId, (current) => {
    if (!current || current.scheduledSettlementLease?.owner !== leaseOwner) return current
    const { scheduledSettlementLease: _, ...channel } = current
    return channel
  })
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
  /** Marks an SSE receipt whose first content unit was charged during verification. */
  markPrepaidReceipt?: ((receipt: SessionReceipt) => SessionReceipt) | undefined
  /** Whether SSE transport is enabled. SSE accounting is stream-driven, not HTTP-response-driven. */
  sseEnabled: boolean
  /** Runs optional server settlement policy after a successful content charge. */
  settleCharged: SettleChargedSessionChannel
}

/** Returns whether an accepted credential will authorize and charge an HTTP content response. */
export function shouldApplyVerifiedHttpAccounting(
  parameters: Pick<
    ApplyVerifiedHttpAccountingParameters,
    'capturedRequest' | 'payloadAction' | 'sseEnabled'
  >,
): boolean {
  const { capturedRequest, payloadAction, sseEnabled } = parameters
  if (!capturedRequest) return false
  if (payloadAction !== 'open' && payloadAction !== 'voucher') return false
  if (sseEnabled && capturedRequest.method === 'POST') return false
  return isSessionContentRequest(capturedRequest)
}

/** Applies the default HTTP content charge after a session credential has been accepted. */
export async function applyVerifiedHttpAccounting(
  parameters: ApplyVerifiedHttpAccountingParameters,
): Promise<SessionReceipt> {
  const { receipt, sseEnabled } = parameters
  if (!shouldApplyVerifiedHttpAccounting(parameters)) return receipt

  const requestAmount = parameters.getRequestAmount()
  const charged = await parameters.charge(receipt.channelId, requestAmount)
  const settlementTxHash = await parameters.settleCharged(charged)
  const chargedReceipt = {
    ...receipt,
    spent: charged.spent.toString(),
    units: charged.units,
    ...(settlementTxHash ? { txHash: settlementTxHash } : {}),
  }
  return sseEnabled
    ? (parameters.markPrepaidReceipt?.(chargedReceipt) ?? chargedReceipt)
    : chargedReceipt
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
    if (ChannelStore.hasActiveCloseClaim(result.channel))
      throw new ChannelClosedError({ reason: 'channel close is already in progress' })
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
  /** Fee-payer account, or `true` when the client transport uses a configured hosted fee-payer service. */
  feePayer?: viem_Account | true | undefined
  /** Optional policy for sponsored settlement. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Optional fee token override for settlement. */
  feeToken?: Address | undefined
  /** Callback invoked after the settlement transaction is confirmed. */
  onSessionSettlement?: OnSessionSettlement | undefined
  /** Accounting trigger to preserve if confirmed state needs later recovery. */
  trigger?: Extract<SessionSettlementContext['trigger'], 'scheduled' | 'settle'> | undefined
}

/** Inputs for reconciling a settlement that was confirmed before local persistence completed. */
export type ReconcileConfirmedSettlementClaimParameters = {
  /** Persisted precompile channel containing the confirmed claim. */
  channel: ChannelStore.StoredPrecompileChannel
  /** Client used to verify the current on-chain settlement amount. */
  client: Chain.TransactionClient
  /** Settlement options, including an escrow override and accounting callback. */
  options?: SettlementTransactionOptions | undefined
  /** Server-side channel store. */
  store: ChannelStore.ChannelStore
}

/** Inputs for applying a server-owned automatic settlement schedule. */
export type MaybeSettleScheduledParameters = {
  /** Account used to send the settlement transaction. */
  account?: viem_Account | undefined
  /** Channel that was just charged. */
  channel: ChannelStore.State
  /** viem client used to settle on-chain. */
  client: Chain.TransactionClient
  /** Fee-payer account, or `true` when the client transport uses a configured hosted fee-payer service. */
  feePayer?: viem_Account | true | undefined
  /** Optional policy for sponsored settlement. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Optional fee token override for settlement. */
  feeToken?: Address | undefined
  /** Callback invoked after the scheduled settlement transaction is confirmed. */
  onSessionSettlement?: OnSessionSettlement | undefined
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
  if (!schedule || !isSettlementDue(channel, schedule)) return undefined
  const leaseOwner = await claimScheduledSettlement({
    channelId: channel.channelId,
    schedule,
    store,
  })
  if (!leaseOwner) return undefined
  const renewal = setInterval(() => {
    void renewScheduledSettlement({
      channelId: channel.channelId,
      leaseOwner,
      store,
    }).catch(() => undefined)
  }, scheduledSettlementLeaseMs / 2)
  try {
    const txHash = await settleIfAvailable(store, parameters.client, channel.channelId, {
      account: parameters.account,
      ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
      ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
      ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
      onSessionSettlement: parameters.onSessionSettlement,
      trigger: 'scheduled',
    })
    if (!txHash) {
      await releaseScheduledSettlement({ channelId: channel.channelId, leaseOwner, store })
      return undefined
    }
    await markSettlementComplete({ channelId: channel.channelId, leaseOwner, store })
    return txHash
  } catch (error) {
    await releaseScheduledSettlement({ channelId: channel.channelId, leaseOwner, store }).catch(
      () => undefined,
    )
    throw error
  } finally {
    clearInterval(renewal)
  }
}

/** Settles the highest accepted voucher for a precompile-backed session channel. */
export async function settle(
  store_: SessionStoreInput,
  client: Chain.TransactionClient,
  channelId_: Hex,
  options?: SettlementTransactionOptions,
): Promise<Hex> {
  const txHash = await settleIfAvailable(store_, client, channelId_, options)
  if (!txHash)
    throw new VerificationFailedError({ reason: 'channel settlement is already in progress' })
  return txHash
}

/**
 * Settles a channel under a persisted, backend-atomic lease.
 *
 * A confirmed settlement automatically advances to any newer voucher accepted
 * while the transaction was pending. Failures release the lease only when no
 * submission RPC began; ambiguous submission or receipt failures retain it
 * until expiry so another worker cannot broadcast a duplicate transaction.
 */
export async function settleIfAvailable(
  store_: SessionStoreInput,
  client: Chain.TransactionClient,
  channelId_: Hex,
  options?: SettlementTransactionOptions,
): Promise<Hex | undefined> {
  const store = resolveChannelStore(store_)
  if (store.atomic === false)
    throw new VerificationFailedError({
      reason: 'settlement coordination requires an atomic store',
    })
  const channelId = ChannelStore.normalizeChannelId(channelId_)
  let initialChannel = await store.getChannel(channelId)
  if (!initialChannel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(initialChannel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (!initialChannel.highestVoucher)
    throw new VerificationFailedError({ reason: 'no voucher to settle' })
  initialChannel = await reconcileConfirmedSettlementClaim({
    channel: initialChannel,
    client,
    options,
    store,
  })
  const account = options?.account ?? getClientAccount(client)
  const settlementTrigger = options?.trigger ?? 'settle'
  assertSettlementSender({
    operation: 'settle',
    channelId,
    operator: initialChannel.operator,
    payee: initialChannel.payee,
    sender: account?.address,
  })

  const claimId = globalThis.crypto.randomUUID()
  let channel = await claimSettlement()
  if (!channel) return undefined
  let lastTxHash: Hex | undefined

  while (channel.highestVoucher) {
    const escrow = options?.escrowContract ?? channel.escrowContract
    const amount = uint96(channel.highestVoucher.cumulativeAmount)
    const settlementDelta = amount - channel.settledOnChain
    let submissionStarted = false
    let settlementConfirmed = false
    let settlementConfirmation:
      | {
          delta: bigint
          settlementAt: string
          spent: bigint
          trigger: 'scheduled' | 'settle'
          txHash: Hex
          units: number
        }
      | undefined
    let settlementPinWriteCompleted = false
    let settlementPinned = false
    const stopMaintainingSettlementClaim = maintainSettlementClaim(() => settlementConfirmation)
    try {
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
              onSubmission: () => {
                submissionStarted = true
              },
            }
          : undefined,
      )
      const receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
      settlementConfirmed = true
      const confirmation = {
        delta: settlementDelta,
        settlementAt: new Date().toISOString(),
        spent: channel.spent,
        trigger: settlementTrigger,
        txHash,
        units: channel.units,
      }
      settlementConfirmation = confirmation
      const pinned = await store.updateChannel(channelId, (current) => {
        if (!current || current.finalized) return current
        if (
          current.pendingSettlementClaim?.id !== claimId &&
          ChannelStore.hasActiveSettlementClaim(current)
        )
          return current
        return {
          ...current,
          pendingSettlementClaim: {
            amount,
            expiresAt: Number.MAX_SAFE_INTEGER,
            id: claimId,
            ...confirmation,
          },
        }
      })
      settlementPinWriteCompleted = true
      if (
        pinned &&
        !pinned.finalized &&
        (pinned.pendingSettlementClaim?.id !== claimId ||
          !ChannelStore.hasActiveSettlementClaim(pinned))
      )
        throw new VerificationFailedError({ reason: 'failed to retain confirmed settlement state' })
      settlementPinned = true
      stopMaintainingSettlementClaim()
      const settled = readSettledReceiptFields(Chain.getChannelEvent(receipt, 'Settled', channelId))
      const { newSettled } = settled
      if (newSettled < amount)
        throw new VerificationFailedError({ reason: 'Settled event is below voucher amount' })
      const state = await Chain.getChannelState(client, channelId, escrow)
      if (state.settled !== newSettled)
        throw new VerificationFailedError({
          reason: 'on-chain channel state does not match settle receipt',
        })
      await store.updateChannel(channelId, (current) => {
        if (!current) return current
        const settledOnChain =
          newSettled > current.settledOnChain ? newSettled : current.settledOnChain
        const settlement = {
          ...current,
          settledOnChain,
          lastSettlementAt: confirmation.settlementAt,
          lastSettlementSpent: current.spent,
          lastSettlementUnits: current.units,
        }
        if (current.pendingSettlementClaim?.id !== claimId) return settlement
        if (current.highestVoucher && current.highestVoucher.cumulativeAmount > newSettled)
          return {
            ...settlement,
            pendingSettlementClaim: {
              amount: current.highestVoucher.cumulativeAmount,
              expiresAt: Date.now() + ChannelStore.channelTransactionClaimTtlMs,
              id: claimId,
            },
          }
        const { pendingSettlementClaim: _, ...withoutClaim } = settlement
        return withoutClaim
      })
      if (options?.onSessionSettlement) {
        await emitSessionSettlement(options.onSessionSettlement, {
          txHash,
          channelId,
          trigger: settlementTrigger,
          amount: newSettled,
          delta: newSettled - channel.settledOnChain,
        })
      }
      lastTxHash = txHash
      const refreshed = await refreshSettlementClaim(newSettled)
      if (!refreshed) return lastTxHash
      channel = refreshed
    } catch (error) {
      if (!settlementConfirmed || settlementPinned || settlementPinWriteCompleted)
        stopMaintainingSettlementClaim()
      if (!submissionStarted || Chain.isConfirmedTransactionRevert(error))
        await releaseSettlementClaim()
      throw error
    }
  }

  return lastTxHash

  async function claimSettlement(): Promise<ChannelStore.StoredPrecompileChannel | undefined> {
    const now = Date.now()
    const claimed = await store.updateChannel(channelId, (current) => {
      if (!current || !ChannelStore.isPrecompileState(current) || !current.highestVoucher)
        return current
      if (current.highestVoucher.cumulativeAmount <= current.settledOnChain) return current
      if (ChannelStore.hasActiveCloseClaim(current, now)) return current
      const existing = current.pendingSettlementClaim
      if (existing && existing.expiresAt > now) return current
      return {
        ...current,
        pendingSettlementClaim: {
          amount: current.highestVoucher.cumulativeAmount,
          expiresAt: now + ChannelStore.channelTransactionClaimTtlMs,
          id: claimId,
        },
      }
    })
    if (!claimed) throw new ChannelNotFoundError({ reason: 'channel not found' })
    if (!ChannelStore.isPrecompileState(claimed) || !claimed.highestVoucher)
      throw new VerificationFailedError({ reason: 'no voucher to settle' })
    return claimed.pendingSettlementClaim?.id === claimId ? claimed : undefined
  }

  async function releaseSettlementClaim(): Promise<void> {
    await store.updateChannel(channelId, (current) => {
      if (!current || current.pendingSettlementClaim?.id !== claimId) return current
      const { pendingSettlementClaim: _, ...withoutClaim } = current
      return withoutClaim
    })
  }

  /** Keeps this worker's settlement lease active through receipt reconciliation. */
  function maintainSettlementClaim(
    getConfirmation: () =>
      | {
          delta: bigint
          settlementAt: string
          spent: bigint
          trigger: 'scheduled' | 'settle'
          txHash: Hex
          units: number
        }
      | undefined,
  ): () => void {
    const timer = setInterval(() => {
      void store
        .updateChannel(channelId, (current) => {
          if (!current || current.pendingSettlementClaim?.id !== claimId) return current
          const confirmation = getConfirmation()
          return {
            ...current,
            pendingSettlementClaim: {
              ...current.pendingSettlementClaim,
              ...(confirmation ?? {}),
              expiresAt: confirmation
                ? Number.MAX_SAFE_INTEGER
                : Date.now() + ChannelStore.channelTransactionClaimTtlMs,
            },
          }
        })
        .then((current) => {
          if (
            getConfirmation() &&
            current?.pendingSettlementClaim?.id === claimId &&
            current.pendingSettlementClaim.expiresAt === Number.MAX_SAFE_INTEGER
          )
            clearInterval(timer)
        })
        .catch(() => undefined)
    }, ChannelStore.channelTransactionClaimTtlMs / 3)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  }

  /** Atomically renews this worker's lease for a still-unsettled newer voucher. */
  async function refreshSettlementClaim(
    settledAmount: bigint,
  ): Promise<ChannelStore.StoredPrecompileChannel | undefined> {
    const expiresAt = Date.now() + ChannelStore.channelTransactionClaimTtlMs
    const refreshed = await store.updateChannel(channelId, (current) => {
      if (
        !current ||
        !ChannelStore.isPrecompileState(current) ||
        current.pendingSettlementClaim?.id !== claimId
      )
        return current
      if (
        !current.highestVoucher ||
        current.highestVoucher.cumulativeAmount <= settledAmount ||
        current.highestVoucher.cumulativeAmount <= current.settledOnChain
      ) {
        const { pendingSettlementClaim: _, ...withoutClaim } = current
        return withoutClaim
      }
      return {
        ...current,
        pendingSettlementClaim: {
          amount: current.highestVoucher.cumulativeAmount,
          expiresAt,
          id: claimId,
        },
      }
    })
    if (
      !refreshed ||
      !ChannelStore.isPrecompileState(refreshed) ||
      refreshed.pendingSettlementClaim?.id !== claimId ||
      !refreshed.highestVoucher ||
      refreshed.highestVoucher.cumulativeAmount <= settledAmount ||
      refreshed.highestVoucher.cumulativeAmount <= refreshed.settledOnChain
    )
      return undefined
    return refreshed
  }
}

/** Reconciles a permanently pinned, confirmed settlement with local channel state. */
export async function reconcileConfirmedSettlementClaim(
  parameters: ReconcileConfirmedSettlementClaimParameters,
): Promise<ChannelStore.StoredPrecompileChannel> {
  const { channel, client, options, store } = parameters
  const claim = channel.pendingSettlementClaim
  if (!claim || claim.expiresAt !== Number.MAX_SAFE_INTEGER) return channel
  const escrow = options?.escrowContract ?? channel.escrowContract
  const state = await Chain.getChannelState(client, channel.channelId, escrow)
  if (state.settled < claim.amount) return channel
  if (!store.updateChannelResult)
    throw new VerificationFailedError({ reason: 'settlement recovery requires an atomic store' })
  const recovery = await store.updateChannelResult<{
    channel: ChannelStore.State | null
    recovered: boolean
  }>(channel.channelId, (latest) => {
    if (
      !latest ||
      !ChannelStore.isPrecompileState(latest) ||
      latest.pendingSettlementClaim?.id !== claim.id ||
      latest.pendingSettlementClaim.expiresAt !== Number.MAX_SAFE_INTEGER
    )
      return { op: 'noop', result: { channel: latest, recovered: false } }
    const { pendingSettlementClaim: _, ...withoutClaim } = latest
    const reconciled = {
      ...withoutClaim,
      settledOnChain: state.settled > latest.settledOnChain ? state.settled : latest.settledOnChain,
      ...(claim.settlementAt !== undefined && { lastSettlementAt: claim.settlementAt }),
      ...(claim.spent !== undefined && { lastSettlementSpent: claim.spent }),
      ...(claim.units !== undefined && { lastSettlementUnits: claim.units }),
    }
    return {
      op: 'set',
      result: { channel: reconciled, recovered: true },
      value: reconciled,
    }
  })
  const reconciled = recovery.channel
  if (!reconciled) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(reconciled))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (recovery.recovered && claim.txHash && options?.onSessionSettlement)
    await emitSessionSettlement(options.onSessionSettlement, {
      amount: claim.amount,
      channelId: channel.channelId,
      delta: claim.delta ?? claim.amount - channel.settledOnChain,
      trigger: claim.trigger ?? 'settle',
      txHash: claim.txHash,
    })
  return reconciled
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

async function emitSessionSettlement(
  onSessionSettlement: OnSessionSettlement,
  context: SessionSettlementContext,
): Promise<void> {
  try {
    await onSessionSettlement(Object.freeze(context))
  } catch {
    // Errors are isolated — observers cannot break the settlement flow.
  }
}
