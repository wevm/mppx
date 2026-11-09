import { type Address, type Hex, zeroAddress } from 'viem'

import { ChannelNotFoundError, VerificationFailedError } from '../Errors.js'
import type { MaybePromise } from '../internal/types.js'
import * as Store from '../Store.js'
import { parsePkhSource } from '../tempo/internal/proof.js'
import type { TransactionClient } from '../tempo/session/precompile/Chain.js'
import { tip20ChannelEscrow } from '../tempo/session/precompile/Protocol.js'
import {
  isPrecompileState,
  resolveSettleableVoucher,
  type State,
} from '../tempo/session/server/ChannelStore.js'
import * as CloseSupervisor from '../tempo/session/server/CloseSupervisor.js'
import type { ResolveSessionChannelId } from '../tempo/session/server/RequestState.js'
import {
  settle as settleChannel,
  SettlementCheckpointError,
  type SettlementTransactionOptions,
} from '../tempo/session/server/Settlement.js'
import { type ChannelStore, isChannelState, pendingClose, unsettledAmount } from './ChannelStore.js'

/**
 * Tempo session channel storage on a {@link ChannelStore} Durable Object namespace, to spread
 * into `tempo.session()`: `store` keeps each channel in its own object, which schedules its
 * settlement, and `resolveChannelId` finds the payer's open channel to the same payee, token,
 * escrow, operator and chain, so a client that lost its state resumes it instead of opening another.
 * The lookup needs the payer's identity, which only a `bootstrap` HEAD proof supplies: enable
 * `bootstrap` on the session and in the client's session manager, or it never resolves.
 *
 * The store keeps that lookup current: after a write opens, closes or finalizes a channel,
 * it adds or removes the channel under its payer and authorized signer. Each lookup entry is
 * its own key holding the payer's open channels there, most recent first, so closing one leaves
 * the others findable. The lookup returns the first whose channel still resumes, so a delayed
 * write for a channel that has since closed cannot hide an open one, and mppx validates any
 * channel it resolves before reusing it.
 *
 * @example
 * ```ts
 * import { channels } from 'mppx/cloudflare'
 * import { tempo } from 'mppx/server'
 *
 * tempo.session({ account, bootstrap: true, currency, getClient, ...channels(env.MPPX_CHANNELS) })
 * ```
 */
export function channels(
  namespace: channels.Namespace,
  options?: channels.Options,
): channels.ReturnType {
  const base = Store.durableObject(namespace, options)
  const escrowContract = options?.escrowContract ?? tip20ChannelEscrow

  /** Removes `channelId` from the entry under `key`. */
  async function remove(key: string, channelId: Hex) {
    await base.update(key, (current) => {
      const ids = lookupIds(current)
      if (!ids.includes(channelId)) return noop
      const rest = ids.filter((id) => id !== channelId)
      return rest.length
        ? { op: 'set', value: rest, result: undefined }
        : { op: 'delete', result: undefined }
    })
  }

  /**
   * Adds `channelId` to the front of the entry under `key` while its stored channel still
   * resumes, so a delayed add after its close leaves it out. A full entry drops channels that no
   * longer resume before the oldest open one, keeping the most recent {@link maxLookupChannels}.
   */
  async function add(key: string, channelId: Hex) {
    for (let attempt = 1; ; attempt++) {
      const ids = lookupIds(await base.get(key))
      if (ids.includes(channelId)) return
      if (!resumable(await base.get(channelId))) return
      const full = ids.length >= maxLookupChannels
      const states = full ? await Promise.all(ids.map((id) => base.get(id))) : []
      const closed = new Set(ids.filter((_, i) => full && !resumable(states[i])))
      const added = await base.update(key, (current) => {
        const listed = lookupIds(current)
        if (listed.includes(channelId)) return { op: 'noop', result: true }
        // The entry changed since its channels were read: read them again, a few times at most.
        if (attempt < maxLookupAttempts && !sameIds(listed, ids))
          return { op: 'noop', result: false }
        return {
          op: 'set',
          value: [channelId, ...listed.filter((id) => !closed.has(id))].slice(0, maxLookupChannels),
          result: true,
        }
      })
      if (added) return
    }
  }

  /**
   * Moves the lookup entries of a channel from its previous state to its next one. Entries
   * for the next state are written on every write, not only when they change: the channel
   * commits before its entries, so a failed entry write is repaired by the channel's next
   * write instead of staying missing. Writing an entry that is already there changes nothing.
   * Best effort: the channel write has already committed, so a failed entry write must not
   * report it as failed (a charge would apply without its Receipt).
   */
  async function sync(previous: unknown, next: unknown) {
    const before = lookupKeys(previous)
    const after = lookupKeys(next)
    await Promise.allSettled([
      ...before
        .filter((key) => !after.includes(key))
        .map((key) => remove(key, (previous as State).channelId)),
      ...after.map((key) => add(key, (next as State).channelId)),
    ])
  }

  const store: Store.AtomicStore = {
    ...base,
    async put(key, value) {
      const previous = await base.get(key)
      await base.put(key, value)
      await sync(previous, value)
    },
    async delete(key) {
      const previous = await base.get(key)
      await base.delete(key)
      await sync(previous, null)
    },
    async update<result>(
      key: string,
      fn: (current: unknown) => Store.Change<unknown, result>,
    ): Promise<result> {
      // The last call of `fn` is the one the compare-and-swap committed.
      const applied: { change?: Store.Change<unknown, result>; previous: unknown } = {
        previous: null,
      }
      const result = await base.update(key, (current) => {
        applied.previous = current
        applied.change = fn(current)
        return applied.change
      })
      const { change, previous } = applied
      if (change && change.op !== 'noop')
        await sync(previous, change.op === 'set' ? change.value : null)
      return result
    },
  }

  const resolveChannelId: ResolveSessionChannelId = async ({ paymentRequest, source }) => {
    const payer = source ? parsePkhSource(source) : null
    const { recipient } = paymentRequest
    if (!payer || !recipient) return undefined
    if (paymentRequest.chainId !== undefined && paymentRequest.chainId !== payer.chainId)
      return undefined
    const operator = (paymentRequest.operator as Address | undefined) ?? zeroAddress
    const ids = lookupIds(
      await base.get(
        lookupKey({
          chainId: payer.chainId,
          escrowContract: (paymentRequest.escrowContract as Address | undefined) ?? escrowContract,
          payee: recipient,
          operator,
          payer: payer.address,
          token: paymentRequest.currency,
        }),
      ),
    )
    // An ID a delayed write left for a channel that has since closed resumes nothing.
    for (const id of ids) {
      const state = await base.get(id)
      if (!resumable(state)) continue
      // mppx verifies a challenge without an operator against the zero operator, and only
      // channels without one (legacy escrow channels) are not keyed by theirs.
      if (
        isPrecompileState(state)
          ? state.operator.toLowerCase() !== operator.toLowerCase()
          : paymentRequest.operator !== undefined
      )
        continue
      return id
    }
    return undefined
  }

  return { resolveChannelId, store }
}

export declare namespace channels {
  /** The Durable Object namespace binding of a {@link ChannelStore} class. */
  export type Namespace = Store.durableObject.Namespace

  /** Options of {@link channels}: those of {@link Store.durableObject}, and the escrow. */
  export type Options = Store.durableObject.Options & {
    /** Escrow the lookup assumes when a challenge names none. @default the TIP20EscrowChannel precompile */
    escrowContract?: Address | undefined
  }

  /** What `tempo.session()` takes from {@link channels}. */
  export type ReturnType = {
    /** Finds the payer's open channel for a challenge's payee, token, escrow and chain. */
    resolveChannelId: ResolveSessionChannelId
    /** Channel store that schedules settlement and keeps the channel lookup current. */
    store: Store.AtomicStore
  }
}

/**
 * Queues unpaid channels dropped by older settlement schedulers. Run once after upgrading,
 * using every channel ID from the application's channel registry or escrow opening events;
 * dormant Durable Objects cannot enumerate or wake themselves. Safe to rerun after a send failure.
 *
 * @example
 * ```ts
 * await backfillSettlement(channelIds, { store: channels(env.MPPX_CHANNELS).store, queue: env.MPPX_SETTLEMENT_QUEUE })
 * ```
 */
export async function backfillSettlement(
  channelIds: Iterable<Hex> | AsyncIterable<Hex>,
  parameters: { store: Store.AtomicStore; queue: ChannelStore.Queue },
): Promise<number> {
  let queued = 0
  for await (const channelId of channelIds) {
    const state = await parameters.store.get(channelId)
    if (!isChannelState(state) || state.finalized || unsettledAmount(state) <= 0n) continue
    await parameters.queue.send({ channelId })
    queued++
  }
  return queued
}

/**
 * Settles the channels of a settlement queue batch on-chain, from the Worker's `queue()`
 * handler. A voucher above recorded spend uses a payee close that captures only that spend
 * and refunds the remaining deposit. Each message is acknowledged once its channel settled or has nothing left to
 * settle, and when settlement cannot succeed (the channel is gone or has no voucher); any
 * other failure, such as a fee over the fee payer's cap, retries it after 30 s, doubling up
 * to 10 minutes. The {@link ChannelStore} watchdog sends a channel again if its job never settles it.
 *
 * @example
 * ```ts
 * import { channels, settle } from 'mppx/cloudflare'
 *
 * export default {
 *   async queue(batch, env) {
 *     await settle(batch, { account, getClient, store: channels(env.MPPX_CHANNELS).store })
 *   },
 * }
 * ```
 */
export async function settle(batch: settle.Batch, parameters: settle.Parameters): Promise<void> {
  const {
    getClient,
    settle: settle_ = settleChannel,
    store,
    closeSearchFromBlock = 0n,
    ...options
  } = parameters
  for (const message of batch.messages) {
    try {
      const channelId = (message.body as Partial<ChannelStore.Message> | null | undefined)
        ?.channelId
      // A malformed job can never settle: drop it instead of failing the batch.
      if (typeof channelId !== 'string') {
        message.ack()
        continue
      }
      const state = await store.get(channelId)
      // A duplicate job, such as one the watchdog sent while the first was queued, has nothing left.
      if (!isChannelState(state) || state.finalized || unsettledAmount(state) <= 0n) {
        message.ack()
        continue
      }
      // The server's own cooperative close captures it: check again once that close lands or expires.
      if (pendingClose(state)) {
        message.retry({ delaySeconds: 60 })
        continue
      }
      // Another job or a scheduled settlement is settling it: check again once that one is done.
      const leaseOwner = await claim(store, channelId)
      if (!leaseOwner) {
        message.retry({ delaySeconds: 60 })
        continue
      }
      // Waiting for the receipt can outlast the lease: keep it while the settlement runs, so no
      // other job claims the channel and broadcasts the same voucher.
      const renewal = setInterval(() => {
        void renew(store, channelId, leaseOwner).catch(() => undefined)
      }, settlementLeaseMs / 2)
      try {
        const client = await getClient({ chainId: state.chainId })
        if (isPrecompileState(state) && !resolveSettleableVoucher(state)) {
          const result = await CloseSupervisor.superviseCloses({
            ...options,
            channelIds: [channelId as Hex],
            client,
            closeUnsettled: true,
            settlementLeaseOwner: leaseOwner,
            previousBlock: closeSearchFromBlock,
            closeSearchMarginBlocks: 0n,
            store,
          })
          if (
            !['closed', 'settled', 'unrecovered', 'finalized', 'missing'].includes(
              result.channels[0]?.outcome ?? 'failed',
            )
          ) {
            message.retry({ delaySeconds: 60 })
            continue
          }
        } else {
          await settle_(store, client, channelId, options)
        }
      } finally {
        clearInterval(renewal)
        await release(store, channelId, leaseOwner).catch(() => undefined)
      }
      message.ack()
    } catch (error) {
      if (isPermanent(error)) message.ack()
      else
        message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 600) })
    }
  }
}

export declare namespace settle {
  /** Parameters of {@link settle}: the channel store, a client, and the settlement transaction's options. */
  export type Parameters = SettlementTransactionOptions & {
    /** Earliest escrow block for channels without a supervision checkpoint; must precede every channel opening. @default 0n */
    closeSearchFromBlock?: bigint | undefined
    /** Returns an account-bearing client for the channel's chain. */
    getClient: (parameters: { chainId: number }) => MaybePromise<TransactionClient>
    /** Settles one channel. @default mppx's `Session.Server.settle` */
    settle?: typeof settleChannel | undefined
    /** The channel store, such as {@link channels}' `store`. */
    store: Store.AtomicStore
  }

  /** The subset of a Cloudflare `MessageBatch` that {@link settle} uses. */
  export type Batch = { readonly messages: readonly Message[] }

  /** The subset of a Cloudflare queue `Message` that {@link settle} uses. */
  export type Message = {
    readonly attempts: number
    readonly body: unknown
    ack(): void
    retry(options?: { delaySeconds?: number }): void
  }
}

const noop = { op: 'noop', result: undefined } as const

/** How long a settlement claim holds before another job may take over, as scheduled settlement's. */
const settlementLeaseMs = 5 * 60_000

/**
 * Claims a channel's settlement with the lease scheduled settlement takes, so overlapping jobs,
 * or a job and a scheduled settlement, never broadcast the same voucher twice. Returns the
 * lease's owner, or `undefined` while another one holds a live lease.
 */
async function claim(store: Store.AtomicStore, channelId: string): Promise<string | undefined> {
  const owner = globalThis.crypto.randomUUID()
  const now = Date.now()
  return store.update(channelId, (current) => {
    if (!isChannelState(current)) return { op: 'noop', result: undefined }
    const lease = current.scheduledSettlementLease
    if (lease && lease.expiresAt > now) return { op: 'noop', result: undefined }
    return {
      op: 'set',
      value: {
        ...current,
        scheduledSettlementLease: { expiresAt: now + settlementLeaseMs, owner },
      },
      result: owner,
    }
  })
}

/** Extends a settlement lease {@link claim} took while its owner still holds it. */
async function renew(store: Store.AtomicStore, channelId: string, owner: string) {
  await store.update(channelId, (current) => {
    if (!isChannelState(current) || current.scheduledSettlementLease?.owner !== owner) return noop
    return {
      op: 'set',
      value: {
        ...current,
        scheduledSettlementLease: { expiresAt: Date.now() + settlementLeaseMs, owner },
      },
      result: undefined,
    }
  })
}

/** Releases a settlement lease {@link claim} took, unless another owner has taken it since. */
async function release(store: Store.AtomicStore, channelId: string, owner: string) {
  await store.update(channelId, (current) => {
    if (!isChannelState(current) || current.scheduledSettlementLease?.owner !== owner) return noop
    const { scheduledSettlementLease: _, ...channel } = current
    return { op: 'set', value: channel, result: undefined }
  })
}

/**
 * Whether a settlement failed for good: the channel or its voucher is gone, the account cannot
 * settle it, or the transaction confirmed and only recording it failed.
 */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof ChannelNotFoundError ||
    error instanceof VerificationFailedError ||
    error instanceof SettlementCheckpointError
  )
}

/**
 * The lookup key of a payer's channel to a payee, token, escrow, operator and chain. The operator
 * is part of it so that channels opened with other operators cannot push a matching one out of
 * the entry's {@link maxLookupChannels}.
 */
function lookupKey(lookup: {
  chainId: number
  escrowContract: string
  operator: string
  payee: string
  payer: string
  token: string
}): string {
  const { chainId, escrowContract, operator, payee, payer, token } = lookup
  return `mppx:session-lookup:v3:${[payer, payee, token, escrowContract, operator].map((address) => address.toLowerCase()).join(':')}:${chainId}`
}

/** Most channels a lookup entry keeps per payer, payee, token, escrow, operator and chain. */
const maxLookupChannels = 8

/** Reads of a full lookup entry's channels before adding to it regardless of concurrent changes. */
const maxLookupAttempts = 3

/** Whether two lookup entries list the same channels in the same order. */
function sameIds(a: readonly Hex[], b: readonly Hex[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** The channel IDs of a lookup entry, most recent first. */
function lookupIds(entry: unknown): Hex[] {
  return Array.isArray(entry) ? entry.filter((id): id is Hex => typeof id === 'string') : []
}

/** Whether a payer may resume a stored channel: open, with no close requested. */
function resumable(state: unknown): state is State {
  return isChannelState(state) && !state.finalized && !state.closeRequestedAt
}

/** The lookup keys of a channel a payer may resume. */
function lookupKeys(state: unknown): string[] {
  if (!resumable(state)) return []
  const signers = new Set([state.payer.toLowerCase(), state.authorizedSigner.toLowerCase()])
  return [...signers].map((payer) =>
    lookupKey({
      chainId: state.chainId,
      escrowContract: state.escrowContract,
      operator: isPrecompileState(state) ? state.operator : zeroAddress,
      payee: state.payee,
      payer,
      token: state.token,
    }),
  )
}
