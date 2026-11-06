import type { Address, Hex } from 'viem'

import { BadRequestError, ChannelNotFoundError, VerificationFailedError } from '../Errors.js'
import type { MaybePromise } from '../internal/types.js'
import * as Store from '../Store.js'
import { parsePkhSource } from '../tempo/internal/proof.js'
import type { TransactionClient } from '../tempo/session/precompile/Chain.js'
import { tip20ChannelEscrow } from '../tempo/session/precompile/Protocol.js'
import type { State } from '../tempo/session/server/ChannelStore.js'
import type { ResolveSessionChannelId } from '../tempo/session/server/RequestState.js'
import {
  settle as settleChannel,
  SettlementCheckpointError,
  type SettlementTransactionOptions,
} from '../tempo/session/server/Settlement.js'
import { type ChannelStore, isChannelState, unsettledAmount } from './ChannelStore.js'

/**
 * Tempo session channel storage on a {@link ChannelStore} Durable Object namespace, to spread
 * into `tempo.session()`: `store` keeps each channel in its own object, which schedules its
 * settlement, and `resolveChannelId` finds the payer's open channel to the same payee, token,
 * escrow and chain, so a client that lost its state resumes it instead of opening another.
 *
 * The store keeps that lookup current: after a write opens, closes or finalizes a channel,
 * it adds or removes the channel under its payer and authorized signer. Each lookup entry is
 * its own key, written with a conditional update, so a stale entry never replaces another
 * channel's, and mppx validates any channel it resolves before reusing it.
 *
 * @example
 * ```ts
 * import { channels } from 'mppx/cloudflare'
 * import { tempo } from 'mppx/server'
 *
 * tempo.session({ account, currency, getClient, ...channels(env.MPPX_CHANNELS) })
 * ```
 */
export function channels(
  namespace: channels.Namespace,
  options?: channels.Options,
): channels.ReturnType {
  const base = Store.durableObject(namespace, options)
  const escrowContract = options?.escrowContract ?? tip20ChannelEscrow

  /** Adds or removes `channelId` under `key`, leaving an entry for another channel alone. */
  const index = (key: string, channelId: Hex, present: boolean) =>
    base.update(key, (current) => {
      if (present)
        return current === channelId ? noop : { op: 'set', value: channelId, result: undefined }
      return current === channelId ? { op: 'delete', result: undefined } : noop
    })

  /**
   * Moves the lookup entries of a channel from its previous state to its next one. Entries
   * for the next state are written on every write, not only when they change: the channel
   * commits before its entries, so a failed entry write is repaired by the channel's next
   * write instead of staying missing. Writing an entry that is already there changes nothing.
   */
  async function sync(previous: unknown, next: unknown) {
    const before = lookupKeys(previous)
    const after = lookupKeys(next)
    await Promise.all([
      ...before
        .filter((key) => !after.includes(key))
        .map((key) => index(key, (previous as State).channelId, false)),
      ...after.map((key) => index(key, (next as State).channelId, true)),
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
    const channelId = await base.get(
      lookupKey({
        chainId: payer.chainId,
        escrowContract: (paymentRequest.escrowContract as Address | undefined) ?? escrowContract,
        payee: recipient,
        payer: payer.address,
        token: paymentRequest.currency,
      }),
    )
    return typeof channelId === 'string' ? channelId : undefined
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
 * Settles the channels of a settlement queue batch on-chain, from the Worker's `queue()`
 * handler. Each message is acknowledged once its channel settled or has nothing left to
 * settle, and when settlement cannot succeed (the channel is gone, has no voucher, or the
 * account is not its payee); any other failure retries it after 30 s, doubling up to 10
 * minutes. The {@link ChannelStore} watchdog sends a channel again if its job never settles it.
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
  const { getClient, settle: settle_ = settleChannel, store, ...options } = parameters
  for (const message of batch.messages) {
    const { channelId } = message.body as ChannelStore.Message
    try {
      const state = await store.get(channelId)
      // A duplicate job, such as one the watchdog sent while the first was queued, has nothing left.
      if (!isChannelState(state) || state.finalized || unsettledAmount(state) <= 0n) {
        message.ack()
        continue
      }
      await settle_(store, await getClient({ chainId: state.chainId }), channelId, options)
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

/**
 * Whether a settlement failed for good: the channel or its voucher is gone, the account cannot
 * settle it, or the transaction confirmed and only recording it failed.
 */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof ChannelNotFoundError ||
    error instanceof VerificationFailedError ||
    error instanceof BadRequestError ||
    error instanceof SettlementCheckpointError
  )
}

/** The lookup key of a payer's channel to a payee, token, escrow and chain. */
function lookupKey(lookup: {
  chainId: number
  escrowContract: string
  payee: string
  payer: string
  token: string
}): string {
  const { chainId, escrowContract, payee, payer, token } = lookup
  return `mppx:session-lookup:v1:${[payer, payee, token, escrowContract].map((address) => address.toLowerCase()).join(':')}:${chainId}`
}

/** The lookup keys of a channel a payer may resume: open, with no close requested. */
function lookupKeys(state: unknown): string[] {
  if (!isChannelState(state) || state.finalized || state.closeRequestedAt !== 0n) return []
  const signers = new Set([state.payer.toLowerCase(), state.authorizedSigner.toLowerCase()])
  return [...signers].map((payer) =>
    lookupKey({
      chainId: state.chainId,
      escrowContract: state.escrowContract,
      payee: state.payee,
      payer,
      token: state.token,
    }),
  )
}
