import { type Address, parseUnits } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import * as CredentialAttempt from '../../../client/internal/CredentialAttempt.js'
import * as MethodChallenge from '../../../client/internal/MethodChallenge.js'
import * as MethodResponse from '../../../client/internal/MethodResponse.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import * as Method from '../../../Method.js'
import * as Account from '../../../viem/Account.js'
import * as Client from '../../../viem/Client.js'
import type {
  ResolveAccount as ResolveAccount_,
  ResolveAccountInfo as ResolveAccountInfo_,
} from '../../client/ResolveAccount.js'
import * as AutoSwap from '../../internal/auto-swap.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Methods.js'
import * as Channel from '../precompile/Channel.js'
import {
  deserializeSessionReceipt,
  isEventStream,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
} from '../precompile/Protocol.js'
import { serializeCredential, type ChannelEntry } from './ChannelOps.js'
import { createChannelStore, type ChannelStore } from './ChannelStore.js'
import {
  canSignDescriptor,
  executeCredentialPlan,
  hasSessionAction,
  planCredential,
  resolveChallengeContext,
  resolveRecoverContext,
  sessionContextSchema,
  type ChallengeContext,
  type SessionContext as CredentialContext,
} from './CredentialState.js'
import { assertWithinMaxDeposit, resolveAutomaticTopUp } from './Runtime.js'
import {
  getSessionSnapshot,
  handleSseNeedVoucher,
  isTip1034SessionChallenge,
  postTopUp,
  wrapSseResponse,
  type SsePaymentDriver,
  type TempoSessionChallenge,
} from './Transports.js'

export { sessionContextSchema, type SessionContext } from './CredentialState.js'

const channelTails = new WeakMap<ChannelStore, Map<string, Promise<void>>>()

/** Serializes automatic opens for one payment scope across methods sharing a store. */
async function lockChannel(store: ChannelStore, key: string) {
  const tails = channelTails.get(store) ?? new Map<string, Promise<void>>()
  channelTails.set(store, tails)
  const previous = tails.get(key)
  let unlock!: () => void
  const current = new Promise<void>((resolve) => {
    unlock = resolve
  })
  tails.set(key, current)
  await previous
  return () => {
    unlock()
    if (tails.get(key) === current) tails.delete(key)
  }
}

function acknowledgesOpen(
  outcome: CredentialAttempt.Outcome,
  challenge: TempoSessionChallenge,
  opened: ChannelEntry,
): boolean {
  const receiptHeader = outcome.response?.headers.get(Constants.Headers.paymentReceipt)
  if (receiptHeader)
    try {
      const receipt = deserializeSessionReceipt(receiptHeader)
      if (
        receipt.challengeId === challenge.id &&
        receipt.channelId.toLowerCase() === opened.channelId.toLowerCase() &&
        BigInt(receipt.acceptedCumulative) === opened.cumulativeAmount
      )
        return true
    } catch {}
  return (
    outcome.challenges?.some((candidate) => {
      if (!isTip1034SessionChallenge(candidate)) return false
      const snapshot = getSessionSnapshot(candidate)
      return (
        snapshot?.channelId.toLowerCase() === opened.channelId.toLowerCase() &&
        BigInt(snapshot.acceptedCumulative) === opened.cumulativeAmount
      )
    }) ?? false
  )
}

/**
 * Creates the low-level TIP-1034 session payment method for use with `Mppx.create()`.
 *
 * Supports auto mode (server hints drive open/top-up sizing, with optional
 * `maxDeposit` as a local cap) and manual mode (`context.action` with a
 * channel descriptor).
 */
export function session(parameters: session.Parameters = {}) {
  const {
    account,
    autoSwap: autoSwapParameter,
    channelStore,
    decimals = defaults.decimals,
    escrow: escrowOverride,
    getClient: getClientParameter,
    maxDeposit: maxDepositParameter,
    topUpAmount: topUpAmountParameter,
    onChannelUpdate,
    resolveAccount,
  } = parameters
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: getClientParameter,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account })
  const maxDeposit =
    maxDepositParameter !== undefined ? parseUnits(maxDepositParameter, decimals) : undefined
  const topUpAmount =
    topUpAmountParameter !== undefined ? parseUnits(topUpAmountParameter, decimals) : undefined
  const store = channelStore ?? createChannelStore()
  const sink = { store, notifyUpdate: (entry: ChannelEntry) => onChannelUpdate?.(entry) }

  const resolveCredentialAccount = async (
    resolved: ChallengeContext,
    context: CredentialContext | undefined,
    entry: ChannelEntry | undefined,
  ) => {
    const defaultAccount = getAccount(resolved.client, context)
    const descriptor = context?.action
      ? context.descriptor
      : (entry?.descriptor ??
        resolveRecoverContext({ context, snapshot: resolved.snapshot })?.descriptor)
    return (
      (await resolveAccount?.({
        account: defaultAccount,
        chainId: resolved.chainId,
        operation: {
          kind: 'authorizePaymentChannel',
          ...(descriptor ? { authority: Channel.resolveAuthorizedSigner(descriptor) } : {}),
        },
      })) ?? defaultAccount
    )
  }

  const method = Method.toClient(Methods.session, {
    canHandleChallenge: ({ challenge }) => isTip1034SessionChallenge(challenge),
    context: sessionContextSchema,
    async createCredential(parameters) {
      const { challenge, context } = parameters
      const resolved = await resolveChallengeContext({
        challenge,
        escrowOverride,
        getClient,
      })
      const controller = CredentialAttempt.get(parameters)
      const ownsResponse = controller && MethodResponse.has(method)
      let entry: ChannelEntry | undefined
      let release: (() => void) | undefined
      try {
        entry = await store.get(resolved.key)
        let account = await resolveCredentialAccount(resolved, context, entry)
        let plan = planCredential({
          account,
          entry,
          context,
          decimals,
          maxDeposit,
          resolved,
        })
        if (ownsResponse && plan.type === 'open') {
          const previousChannelId = entry?.channelId
          release = await lockChannel(store, resolved.key)
          const nextEntry = await store.get(resolved.key)
          if (nextEntry?.channelId !== previousChannelId) {
            entry = nextEntry
            if (entry?.opened) {
              await controller?.prepare()
              entry = await store.get(resolved.key)
            }
            account = await resolveCredentialAccount(resolved, context, entry)
            plan = planCredential({
              account,
              entry,
              context,
              decimals,
              maxDeposit,
              resolved,
            })
          }
        }
        let pendingOpen: ChannelEntry | undefined
        // Defer opens only when low-level Fetch owns the response lifecycle.
        // SessionManager unregisters this hook and keeps its existing transaction boundary.
        const credentialSink =
          ownsResponse && plan.type === 'open'
            ? {
                store: {
                  get: (key: string) => store.get(key),
                  async set(next: ChannelEntry) {
                    pendingOpen = next
                  },
                  delete: (key: string) => store.delete(key),
                },
                notifyUpdate() {},
              }
            : sink
        const payload = await executeCredentialPlan(
          plan,
          credentialSink,
          AutoSwap.resolve(context?.autoSwap ?? autoSwapParameter, AutoSwap.defaultCurrencies),
        )
        const credential = await serializeCredential(challenge, payload, resolved.chainId, account)
        if (controller && pendingOpen) {
          const opened = pendingOpen
          controller.settle = async (outcome) => {
            const accepted =
              outcome.status === 'accepted' || acknowledgesOpen(outcome, challenge, opened)
            if (!accepted && outcome.status === 'pending') return false
            try {
              if (accepted) {
                const current = await store.get(resolved.key)
                if (
                  !current?.opened ||
                  current.channelId.toLowerCase() !== opened.channelId.toLowerCase()
                ) {
                  await store.set(opened)
                  sink.notifyUpdate(opened)
                }
              }
              return true
            } finally {
              release?.()
              release = undefined
            }
          }
        } else {
          release?.()
          release = undefined
        }
        return credential
      } catch (error) {
        release?.()
        throw error
      }
    },
  })

  const topUpChannelIfNeeded = async ({
    challenge,
    channel,
    deposit,
    fetch,
    input,
    requiredCumulative,
  }: {
    challenge: TempoSessionChallenge
    channel: ChannelEntry
    deposit: bigint
    fetch: typeof globalThis.fetch
    input: RequestInfo | URL
    requiredCumulative: bigint
  }) => {
    const knownDeposit = channel.deposit > deposit ? channel.deposit : deposit
    const additionalDeposit = resolveAutomaticTopUp({
      deposit: knownDeposit,
      maxDeposit,
      requiredCumulative,
      suggestedDeposit:
        challenge.request.suggestedDeposit === undefined
          ? undefined
          : BigInt(challenge.request.suggestedDeposit),
      topUpAmount,
    })
    if (additionalDeposit > 0n)
      await postTopUp({
        additionalDeposit,
        challenge,
        channel,
        channelId: channel.channelId,
        createSessionCredential: (challenge, context) =>
          method.createCredential({ challenge, context }),
        fetch,
        input,
      })
    const nextDeposit = knownDeposit + additionalDeposit
    if (nextDeposit === channel.deposit) return
    const updated = { ...channel, deposit: nextDeposit }
    await store.set(updated)
    sink.notifyUpdate(updated)
  }

  MethodChallenge.register(method, async ({ challenge, context, fetch, input }) => {
    if (!isTip1034SessionChallenge(challenge)) return
    const sessionContext = context === undefined ? undefined : sessionContextSchema.parse(context)
    if (hasSessionAction(sessionContext)) return
    const resolved = await resolveChallengeContext({ challenge, escrowOverride, getClient })
    const channel = await store.get(resolved.key)
    if (!channel?.opened) return
    const snapshot =
      resolved.snapshot?.channelId.toLowerCase() === channel.channelId.toLowerCase()
        ? resolved.snapshot
        : undefined
    const nextCumulative = channel.cumulativeAmount + readSessionChallengeAmount(challenge)
    const snapshotRequired = snapshot ? BigInt(snapshot.requiredCumulative) : nextCumulative
    const requiredCumulative = snapshotRequired > nextCumulative ? snapshotRequired : nextCumulative
    const snapshotDeposit = snapshot ? BigInt(snapshot.deposit) : channel.deposit
    const deposit = snapshotDeposit > channel.deposit ? snapshotDeposit : channel.deposit
    if (requiredCumulative <= deposit && deposit === channel.deposit) return
    const account = await resolveCredentialAccount(resolved, sessionContext, channel)
    if (!canSignDescriptor(account, channel.descriptor)) return
    await topUpChannelIfNeeded({
      challenge,
      channel,
      deposit,
      fetch,
      input,
      requiredCumulative,
    })
  })

  return MethodResponse.register(
    method,
    async ({ challenge, credential, fetch, headers, input, refetch, response, signal }) => {
      if (!isTip1034SessionChallenge(challenge)) return response
      if (!isEventStream(response)) {
        const credentialContext = requireSessionCredentialContext(
          Credential.deserialize(credential).payload,
        )
        if (
          credentialContext.action === 'open' &&
          headers.get('accept')?.toLowerCase().includes('text/event-stream')
        )
          return (await refetch?.()) ?? response
        return response
      }

      const channelKey = (
        await resolveChallengeContext({
          challenge,
          escrowOverride,
          getClient,
        })
      ).key
      let channel = await store.get(channelKey)
      const driver = {
        assertVoucherWithinLocalLimit: (cumulativeAmount) =>
          assertWithinMaxDeposit(cumulativeAmount, maxDeposit),
        createSessionCredential: (challenge, context) =>
          method.createCredential({ challenge, context }),
        fetch,
        getChannel: () => channel ?? null,
        async topUpIfNeeded({ deposit, requiredCumulative }) {
          if (!channel) return
          await topUpChannelIfNeeded({
            challenge,
            channel,
            deposit: channel.deposit > deposit ? channel.deposit : deposit,
            fetch,
            input,
            requiredCumulative,
          })
        },
      } satisfies SsePaymentDriver

      return wrapSseResponse({
        onNeedVoucher: (event) => handleSseNeedVoucher({ challenge, driver, input }, event),
        onReceipt() {},
        response,
        signal,
      })
    },
  )
}

/** Type helpers for the low-level TIP-1034 session client method. */
export declare namespace session {
  type ResolveAccount = ResolveAccount_
  type ResolveAccountInfo = ResolveAccountInfo_

  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Automatically acquire the session currency from fallback stablecoins before open/top-up. */
      autoSwap?: AutoSwap.resolve.Value | undefined
      /** Pluggable persistence for reusable channels. Defaults to an in-memory store. */
      channelStore?: ChannelStore | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** TIP20EscrowChannel address override. */
      escrow?: Address | undefined
      /** Maximum channel deposit in human-readable units. Caps server-suggested opens and automatic top-ups. */
      maxDeposit?: string | undefined
      /**
       * Preferred automatic top-up size in human-readable units. When omitted,
       * a bounded server `suggestedDeposit` is preferred, then the exact shortfall.
       */
      topUpAmount?: string | undefined
      /** Called whenever channel state changes. */
      onChannelUpdate?: ((entry: ChannelEntry) => void) | undefined
      /** Selects the account that signs this session credential after the challenge is known. */
      resolveAccount?: ResolveAccount | undefined
    }
}
