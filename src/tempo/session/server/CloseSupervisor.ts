import { getAbiItem, type Hex } from 'viem'
import { getBlock, getLogs } from 'viem/actions'

import { VerificationFailedError } from '../../../Errors.js'
import * as Chain from '../precompile/Chain.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import * as ChannelStore from './ChannelStore.js'
import {
  assertSettlementSender,
  getClientAccount,
  maybeSettleScheduled,
  type OnSessionSettlementFailure,
  reportSessionSettlementFailure,
  type ResolvedSettlementSchedule,
  resolveChannelStore,
  type SessionStoreInput,
  type SettlementTransactionOptions,
} from './Settlement.js'

/** Escrow event every close and withdrawal emits, with the amount paid to the payee. */
const channelClosedEvent = getAbiItem({ abi: escrowAbi, name: 'ChannelClosed' })

/** Channels whose escrow states one call reads, bounding its calldata and response size. */
export const defaultBatchSize = 50

/** Widest log query `rpc.tempo.xyz` accepts; wider ones fail with "query exceeds max block range". */
export const defaultLogBlockRange = 100_000n

/**
 * Blocks searched before the previous complete supervision for the close event of a channel no
 * supervision has read open yet: about 18 minutes of 0.55-second Tempo blocks, longer than the
 * escrow's 900-second close grace period and the interval between supervisions.
 */
export const defaultCloseSearchMarginBlocks = 2_000n

/** What one supervision did with a channel. */
export type CloseSupervisionOutcome =
  /** Open with no close request, or not yet open at the pinned block. */
  | 'open'
  /** Open, and settled because its spend crossed `settlementSchedule`. */
  | 'settled'
  /** Close requested, with nothing above the settled amount to capture; the payer's withdrawal finalizes it. */
  | 'closing'
  /** A close request recorded on the channel was cancelled on-chain, so the channel accepts charges again. */
  | 'cancelled'
  /** A payee close captured the channel's spend, or its deposit left the escrow with it paid. */
  | 'closed'
  /** The deposit left the escrow paying the payee less than the channel's spend. */
  | 'unrecovered'
  /** Already finalized in the store. */
  | 'finalized'
  /** No precompile channel record in the store. */
  | 'missing'
  /** The channel could not be read or answered; a later supervision retries it. */
  | 'failed'

/** Result of one {@link superviseCloses} run. */
export type CloseSupervision = {
  /** Block every escrow read was pinned to. Pass it as `previousBlock` once `complete`. */
  block: bigint
  /** Timestamp of `block` in Unix seconds, e.g. to alert when the last complete run grows old. */
  timestamp: number
  /** Whether every channel was read and handled, so `block` bounds later close-event searches. */
  complete: boolean
  /** Channels supervised. */
  supervised: number
  /** Close requests found cancelled. */
  cancelled: number
  /** Channels closed or found closed with their spend paid. */
  closed: number
  /** Channels that failed. */
  failed: number
  /** Open channels settled on `settlementSchedule`. */
  settled: number
  /** Channels whose deposit left the escrow before their spend was captured. */
  unrecovered: number
  /**
   * Per-channel outcomes, in supervision order. Channels whose outcome is `closed`, `unrecovered`,
   * `finalized` or `missing` need no further supervision.
   */
  channels: {
    channelId: Hex
    outcome: CloseSupervisionOutcome
    error?: unknown
    txHash?: Hex | undefined
  }[]
}

/** Inputs for {@link superviseCloses}. */
export type SuperviseClosesParameters = Pick<
  SettlementTransactionOptions,
  | 'account'
  | 'candidateFeeTokens'
  | 'feePayer'
  | 'feePayerPolicy'
  | 'feeToken'
  | 'onSessionSettlement'
> & {
  /** Channels per escrow state read. @default 50 */
  batchSize?: number | undefined
  /**
   * Channels to supervise. A channel store cannot list its channels, so the caller keeps their IDs:
   * add a channel before its first charge and drop it once a supervision reports it `closed`,
   * `unrecovered`, `finalized` or `missing`.
   */
  channelIds: Iterable<Hex> | AsyncIterable<Hex>
  /** viem client for reads and payee closes on the channels' chain. */
  client: Chain.TransactionClient
  /** Blocks searched before `previousBlock` for a channel no supervision has read open. @default 2_000n */
  closeSearchMarginBlocks?: bigint | undefined
  /** Widest block range of one log query. @default 100_000n */
  logBlockRange?: bigint | undefined
  /** Callback invoked when a payee close fails. Observer errors are ignored. */
  onSessionSettlementFailure?: OnSessionSettlementFailure | undefined
  /** `block` of the last `complete` supervision, which bounds close-event searches. */
  previousBlock?: bigint | undefined
  /**
   * Settles open channels whose spend since their last settlement crossed this schedule, in raw
   * token units, with the account and fee options of closes. Servers that charge channels with
   * `charge()` rather than through the session handler, whose own schedule runs on each
   * charge, use it to collect spend without waiting for a close. Settlement captures only a voucher
   * within spend. Without it, open channels are only read.
   */
  settlementSchedule?: ResolvedSettlementSchedule | undefined
  /** Server channel store. */
  store: SessionStoreInput
}

/**
 * Answers payer close requests on channels the server is not otherwise touching. After a payer
 * requests a close on-chain, the escrow lets it withdraw the whole deposit once its close grace
 * period (900 seconds on Tempo) ends, so call this from a scheduled job well within that period,
 * for example every minute.
 *
 * Each run reads the escrow state of every channel at one pinned block, in batches. A close request
 * is answered with a payee close capturing `max(spent, settled)`, bounded by the highest voucher and
 * the deposit, which pays the accepted charges and refunds the rest; the close pays fees as
 * configured, e.g. `feeToken` when the channel token cannot pay them. A deposit that already left
 * the escrow is finalized from its `ChannelClosed` event, searched in pages of `logBlockRange`
 * blocks. A close request cancelled on-chain reopens the channel.
 */
export async function superviseCloses(
  parameters: SuperviseClosesParameters,
): Promise<CloseSupervision> {
  const { client } = parameters
  const store = resolveChannelStore(parameters.store)
  const batchSize = parameters.batchSize ?? defaultBatchSize
  // A read pinned to this block fails on a node that has not reached it, instead of answering
  // with older state that would hide a close request.
  const block = await getBlock(client, { blockTag: 'latest' })
  const pinned = { number: block.number, timestamp: Number(block.timestamp) }
  const supervision: CloseSupervision = {
    block: pinned.number,
    cancelled: 0,
    channels: [],
    closed: 0,
    complete: false,
    failed: 0,
    settled: 0,
    supervised: 0,
    timestamp: pinned.timestamp,
    unrecovered: 0,
  }
  const report = (
    channelId: Hex,
    outcome: CloseSupervisionOutcome,
    details: { error?: unknown; txHash?: Hex | undefined } = {},
  ) => {
    supervision.supervised += 1
    if (
      outcome === 'cancelled' ||
      outcome === 'closed' ||
      outcome === 'failed' ||
      outcome === 'settled' ||
      outcome === 'unrecovered'
    )
      supervision[outcome] += 1
    supervision.channels.push({ channelId, outcome, ...details })
  }

  const superviseBatch = async (channelIds: readonly Hex[]) => {
    const live: ChannelStore.StoredPrecompileChannel[] = []
    for (const channelId of channelIds) {
      let channel: ChannelStore.State | null
      try {
        channel = await store.getChannel(channelId)
      } catch (error) {
        report(channelId, 'failed', { error })
        continue
      }
      if (!channel || !ChannelStore.isPrecompileState(channel)) report(channelId, 'missing')
      else if (channel.finalized) report(channelId, 'finalized')
      else if (client.chain && client.chain.id !== channel.chainId)
        report(channelId, 'failed', {
          error: new Error(`Channel is on chain ${channel.chainId}, not ${client.chain.id}.`),
        })
      else live.push(channel)
    }
    const byEscrow = new Map<string, ChannelStore.StoredPrecompileChannel[]>()
    for (const channel of live) {
      const escrow = channel.escrowContract.toLowerCase()
      byEscrow.set(escrow, [...(byEscrow.get(escrow) ?? []), channel])
    }
    for (const members of byEscrow.values()) {
      let states: Chain.ChannelState[]
      try {
        states = await Chain.getChannelStatesBatch(
          client,
          members.map(({ channelId }) => channelId),
          members[0]!.escrowContract,
          pinned.number,
        )
      } catch (error) {
        for (const { channelId } of members) report(channelId, 'failed', { error })
        continue
      }
      for (const [index, channel] of members.entries()) {
        const state = states[index]
        if (!state) {
          report(channel.channelId, 'failed', { error: new Error('Escrow state missing.') })
          continue
        }
        try {
          const { outcome, txHash } = await superviseChannel(parameters, store, channel, state, {
            pinned,
            previous: parameters.previousBlock,
          })
          report(channel.channelId, outcome, { txHash })
        } catch (error) {
          // A close that landed before this failure is found by its close event next time.
          report(channel.channelId, 'failed', { error })
        }
      }
    }
  }

  let batch: Hex[] = []
  for await (const channelId of parameters.channelIds) {
    batch.push(channelId)
    if (batch.length < batchSize) continue
    await superviseBatch(batch)
    batch = []
  }
  if (batch.length > 0) await superviseBatch(batch)
  supervision.complete = supervision.failed === 0
  return supervision
}

/** Applies one pinned escrow read of a supervised channel. */
async function superviseChannel(
  parameters: SuperviseClosesParameters,
  store: ChannelStore.ChannelStore,
  channel: ChannelStore.StoredPrecompileChannel,
  state: Chain.ChannelState,
  blocks: { pinned: { number: bigint; timestamp: number }; previous: bigint | undefined },
): Promise<{ outcome: CloseSupervisionOutcome; txHash?: Hex | undefined }> {
  const { channelId } = channel
  if (state.deposit === 0n) {
    // A complete supervision read every listed channel that is still supervised, so a channel read
    // open lost its deposit after the later of that read and the previous complete supervision. A
    // channel no supervision has read open was listed after the previous complete one.
    const since = channel.closeSupervisedFromBlock
    const { previous } = blocks
    const margin = parameters.closeSearchMarginBlocks ?? defaultCloseSearchMarginBlocks
    const fromBlock =
      since === undefined
        ? (previous ?? blocks.pinned.number) - margin
        : previous !== undefined && previous > since
          ? previous
          : since
    const paid = await findSettledToPayee(parameters, channel, {
      fromBlock: fromBlock > 0n ? fromBlock : 0n,
      toBlock: blocks.pinned.number,
    })
    if (paid === undefined) {
      // An open landing after the pinned block also reads as no deposit; a later run reads it.
      if (since === undefined) return { outcome: 'open' }
      throw new VerificationFailedError({
        reason: 'channel left the escrow without a ChannelClosed event in its search range',
      })
    }
    const finalized = await store.updateChannel(channelId, (current) =>
      current && !current.finalized
        ? {
            ...current,
            closeRequestedAt: 0n,
            deposit: 0n,
            finalized: true,
            settledOnChain: ChannelStore.keepGreater(current.settledOnChain, paid),
          }
        : current,
    )
    return { outcome: paid >= (finalized?.spent ?? channel.spent) ? 'closed' : 'unrecovered' }
  }
  if (channel.closeSupervisedFromBlock === undefined)
    await store.updateChannel(channelId, (current) =>
      current && current.closeSupervisedFromBlock === undefined
        ? { ...current, closeSupervisedFromBlock: blocks.pinned.number }
        : current,
    )
  if (state.closeRequestedAt === 0) {
    if (channel.closeRequestedAt === 0n) return settleDue(parameters, store, channel)
    // A pinned read without a request means the payer cancelled it, unless the record holds a
    // server close that may still land: those expire before they are cleared.
    const cleared: { channel?: ChannelStore.State | null } = {}
    await store.updateChannel(channelId, (current) => {
      cleared.channel = ChannelStore.reconcileExpiredPendingClose({
        current,
        now: blocks.pinned.timestamp,
        state,
      })
      return cleared.channel
    })
    return {
      outcome:
        cleared.channel && cleared.channel.closeRequestedAt === 0n && !cleared.channel.finalized
          ? 'cancelled'
          : 'open',
    }
  }
  // A pending close stops charges and credits, so the spend this close captures stays fixed.
  const closing = await store.updateChannel(channelId, (current) =>
    current && !current.finalized
      ? { ...current, ...ChannelStore.mergeActiveOnChainState(current, state) }
      : current,
  )
  if (!closing || closing.finalized || !ChannelStore.isPrecompileState(closing))
    return { outcome: 'finalized' }
  return closeAtSpend(parameters, store, closing, state)
}

/** Settles an open channel when its spend crossed the settlement schedule. */
async function settleDue(
  parameters: SuperviseClosesParameters,
  store: ChannelStore.ChannelStore,
  channel: ChannelStore.StoredPrecompileChannel,
): Promise<{ outcome: CloseSupervisionOutcome; txHash?: Hex | undefined }> {
  const { client, settlementSchedule } = parameters
  if (!settlementSchedule) return { outcome: 'open' }
  const txHash = await maybeSettleScheduled({
    account: parameters.account ?? getClientAccount(client),
    channel,
    client,
    ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
    ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
    ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
    onSessionSettlement: parameters.onSessionSettlement,
    onSessionSettlementFailure: parameters.onSessionSettlementFailure,
    schedule: settlementSchedule,
    store,
  })
  return txHash ? { outcome: 'settled', txHash } : { outcome: 'open' }
}

/** Sends a payee close capturing the channel's spend and finalizes the channel. */
async function closeAtSpend(
  parameters: SuperviseClosesParameters,
  store: ChannelStore.ChannelStore,
  channel: ChannelStore.StoredPrecompileChannel,
  state: Chain.ChannelState,
): Promise<{ outcome: CloseSupervisionOutcome; txHash?: Hex | undefined }> {
  const { client } = parameters
  const { channelId } = channel
  try {
    const voucher = channel.highestVoucher
    if (!voucher) throw new VerificationFailedError({ reason: 'no voucher to close with' })
    const capture = ChannelStore.resolveCloseCaptureAmount({
      cumulativeAmount: voucher.cumulativeAmount,
      onChainDeposit: state.deposit,
      onChainSettled: state.settled,
      spent: channel.spent,
    })
    if (capture <= state.settled) return { outcome: 'closing' }
    const account = parameters.account ?? getClientAccount(client)
    assertSettlementSender({
      operation: 'close',
      channelId,
      operator: channel.operator,
      payee: channel.payee,
      sender: account?.address,
    })
    const txHash = await Chain.closeOnChain(
      client,
      channel.descriptor,
      voucher.cumulativeAmount,
      capture,
      voucher.signature,
      channel.escrowContract,
      account
        ? {
            account,
            candidateFeeTokens: parameters.candidateFeeTokens ?? [channel.token],
            ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
            ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
            ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
          }
        : undefined,
    )
    const receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
    const { refundedToPayer, settledToPayee } = Chain.readChannelClosedReceiptFields(
      Chain.getChannelEvent(receipt, 'ChannelClosed', channelId),
    )
    if (settledToPayee > capture || settledToPayee + refundedToPayer > state.deposit)
      throw new VerificationFailedError({ reason: 'ChannelClosed amounts do not match state' })
    await store.updateChannel(channelId, (current) =>
      ChannelStore.finalizeClosedChannelState({
        captureAmount: settledToPayee,
        channelId,
        cumulativeAmount: voucher.cumulativeAmount,
        current,
        signature: voucher.signature,
      }),
    )
    if (parameters.onSessionSettlement) {
      try {
        await parameters.onSessionSettlement(
          Object.freeze({
            amount: settledToPayee,
            channelId,
            delta: settledToPayee - state.settled,
            trigger: 'close' as const,
            txHash,
          }),
        )
      } catch {
        // Errors are isolated: observers cannot break the close.
      }
    }
    return { outcome: 'closed', txHash }
  } catch (error) {
    await reportSessionSettlementFailure(parameters.onSessionSettlementFailure, {
      chainId: channel.chainId,
      channelId,
      error,
      trigger: 'close',
    })
    throw error
  }
}

/** Amount paid to the payee when the channel closed within the blocks, if it did. */
async function findSettledToPayee(
  parameters: SuperviseClosesParameters,
  channel: ChannelStore.StoredPrecompileChannel,
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<bigint | undefined> {
  const step = parameters.logBlockRange ?? defaultLogBlockRange
  for (let from = range.fromBlock; from <= range.toBlock; from += step) {
    const to = from + step - 1n < range.toBlock ? from + step - 1n : range.toBlock
    const logs = await getLogs(parameters.client, {
      address: channel.escrowContract,
      args: { channelId: channel.channelId },
      event: channelClosedEvent,
      fromBlock: from,
      toBlock: to,
    })
    const paid = logs.find((log) => !log.removed)?.args.settledToPayee
    if (paid !== undefined) return paid
  }
  return undefined
}
