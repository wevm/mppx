import { isAddressEqual, type Account as ViemAccount, type Address, parseUnits } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import type * as Challenge from '../../../Challenge.js'
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
import * as MachineTokenSession from '../../internal/machine-token-session.js'
import * as Methods from '../../Methods.js'
import * as Chain from '../precompile/Chain.js'
import * as Channel from '../precompile/Channel.js'
import {
  deserializeSessionReceipt,
  isEventStream,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
  tip20ChannelEscrow,
} from '../precompile/Protocol.js'
import { createVoucherPayload, serializeCredential, type ChannelEntry } from './ChannelOps.js'
import { createChannelStore, entryKey, type ChannelStore } from './ChannelStore.js'
import {
  canSignDescriptor,
  executeCredentialPlan,
  hasSessionAction,
  planCredential,
  requireContextAmount,
  resolveChallengeContext,
  resolveRecoverContext,
  sessionContextSchema,
  type ChallengeContext,
  type SessionContext as CredentialContext,
} from './CredentialState.js'
import { assertWithinMaxDeposit, resolveAutomaticTopUp, resolveOpeningDeposit } from './Runtime.js'
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

/** Tail promise for each payment scope, used to serialize automatic opens per store. */
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

function matchesOpen(
  opened: ChannelEntry,
  acknowledgement: { acceptedCumulative: string; channelId: string } | null | undefined,
): boolean {
  try {
    return (
      acknowledgement?.channelId.toLowerCase() === opened.channelId.toLowerCase() &&
      BigInt(acknowledgement.acceptedCumulative) === opened.cumulativeAmount
    )
  } catch {
    return false
  }
}

/**
 * Returns whether the server acknowledged an open.
 *
 * Receipts must match the originating challenge, channel, and cumulative amount.
 * Replacement challenges may acknowledge the same channel and amount through a
 * session snapshot. Malformed acknowledgements are ignored.
 */
function acknowledgesOpen(
  outcome: MethodResponse.AttemptOutcome,
  challenge: TempoSessionChallenge,
  opened: ChannelEntry,
): boolean {
  try {
    const receiptHeader = outcome.response?.headers.get(Constants.Headers.paymentReceipt)
    if (receiptHeader) {
      const receipt = deserializeSessionReceipt(receiptHeader)
      if (receipt.challengeId === challenge.id && matchesOpen(opened, receipt)) return true
    }
  } catch {}
  return (
    outcome.challenges?.some((candidate) => {
      if (!isTip1034SessionChallenge(candidate)) return false
      return matchesOpen(opened, getSessionSnapshot(candidate))
    }) ?? false
  )
}

function applyMachineTokenRoute(
  resolved: ChallengeContext,
  route: MachineTokenSession.Route,
): ChallengeContext {
  const snapshotDescriptor = resolved.snapshot?.descriptor
  const snapshotMatches =
    snapshotDescriptor &&
    isAddressEqual(snapshotDescriptor.payee, route.payee) &&
    isAddressEqual(snapshotDescriptor.operator, route.operator) &&
    isAddressEqual(snapshotDescriptor.token, route.token)
  return {
    ...resolved,
    operator: route.operator,
    payee: route.payee,
    paymentScope: { payee: resolved.payee, token: resolved.token },
    snapshot: snapshotMatches ? resolved.snapshot : undefined,
    token: route.token,
  }
}

async function resolveMachineContext(
  resolved: ChallengeContext,
  context: CredentialContext | undefined,
): Promise<ChallengeContext | undefined> {
  const descriptor = context?.descriptor ?? resolved.snapshot?.descriptor
  if (!descriptor) return undefined
  if (!MachineTokenSession.matchDeployment({ chainId: resolved.chainId, descriptor }))
    return undefined
  const closing = context?.action === 'close'
  if (
    (!closing && !MachineTokenSession.isEnabledChallenge(resolved.challenge)) ||
    !isAddressEqual(resolved.escrow, tip20ChannelEscrow)
  )
    return undefined

  const route = await MachineTokenSession.matchRoute(resolved.client, {
    active: !closing,
    chainId: resolved.chainId,
    descriptor,
    merchant: resolved.payee,
    targetToken: resolved.token,
  })
  if (!route)
    throw new Error('Machine-token channel is not bound to this merchant session challenge.')
  return applyMachineTokenRoute(resolved, route)
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
    allowCustomEscrow = false,
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

  const commitEntry = async (entry: ChannelEntry | undefined) => {
    if (!entry) return
    if (entry.opened) await store.set(entry)
    else await store.delete(entryKey(entry))
    onChannelUpdate?.(entry)
  }

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

  const resolveContext = (challenge: Challenge.Challenge) =>
    resolveChallengeContext({
      allowCustomEscrow,
      challenge,
      escrowOverride,
      getClient,
    })

  /** Selects one rail for this channel lifecycle before any credential is signed. */
  const resolveRail = async (direct: ChallengeContext, context: CredentialContext | undefined) => {
    let account: ViemAccount | undefined
    const descriptor = context?.descriptor ?? direct.snapshot?.descriptor
    if (descriptor || hasSessionAction(context)) {
      const machine = descriptor ? await resolveMachineContext(direct, context) : undefined
      const resolved = machine ?? direct
      return {
        account,
        entry: await store.get(resolved.key),
        machine: machine !== undefined,
        resolved,
      }
    }

    const directEntry = await store.get(direct.key)
    if (directEntry?.opened) {
      if (
        !MachineTokenSession.matchDeployment({
          chainId: direct.chainId,
          descriptor: directEntry.descriptor,
        })
      )
        return { account, entry: directEntry, machine: false, resolved: direct }
      const machine = await resolveMachineContext(direct, { descriptor: directEntry.descriptor })
      if (!machine)
        throw new Error('Machine-token channel is not bound to this merchant session challenge.')
      return { account, entry: directEntry, machine: true, resolved: machine }
    }
    if (
      !MachineTokenSession.isEnabledChallenge(direct.challenge) ||
      !isAddressEqual(direct.escrow, tip20ChannelEscrow)
    )
      return { account, entry: undefined, machine: false, resolved: direct }

    const route = await MachineTokenSession.resolveRoute(direct.client, {
      chainId: direct.chainId,
      merchant: direct.payee,
      targetToken: direct.token,
    }).catch(() => undefined)
    if (!route) return { account, entry: undefined, machine: false, resolved: direct }

    const machine = applyMachineTokenRoute(direct, route)
    account = await resolveCredentialAccount(machine, context, undefined)
    const openingDeposit = resolveOpeningDeposit({
      contextDepositRaw: context?.depositRaw,
      maxDeposit,
      requestAmount: direct.amount,
      suggestedDepositRaw: direct.suggestedDepositRaw,
    })
    const funded = await MachineTokenSession.hasSufficientBalance(machine.client, {
      account: account.address,
      amount: openingDeposit,
      token: machine.token,
    })
    return funded
      ? { account, entry: undefined, machine: true, resolved: machine }
      : { account, entry: undefined, machine: false, resolved: direct }
  }

  const method = Method.toClient(Methods.session, {
    canHandleChallenge: ({ challenge }) => isTip1034SessionChallenge(challenge),
    context: sessionContextSchema,
    async createCredential(parameters) {
      const { challenge, context } = parameters
      const attempt = MethodResponse.getAttempt(parameters)
      let release = () => {}
      try {
        const direct = await resolveContext(challenge)
        if (!hasSessionAction(context) && context?.descriptor === undefined) {
          release = await lockChannel(store, direct.key)
          if (attempt && (await store.get(direct.key))?.opened) await attempt.prepare()
        }
        const { account, entry, machine, resolved } = await resolveRail(direct, context)
        const credentialAccount =
          account ?? (await resolveCredentialAccount(resolved, context, entry))
        const plan = planCredential({
          account: credentialAccount,
          entry,
          context,
          decimals,
          maxDeposit,
          resolved,
        })
        if (machine && plan.type === 'manual' && plan.context.action === 'topUp') {
          const additionalDeposit = requireContextAmount(
            plan.context,
            plan.decimals,
            'additionalDeposit',
            'topUp',
          )
          if (
            !(await MachineTokenSession.hasSufficientBalance(plan.resolved.client, {
              account: plan.account.address,
              amount: additionalDeposit,
              token: plan.resolved.token,
            }))
          )
            throw new Error('Insufficient machine-token balance for session top-up.')
        }
        const feeToken = MachineTokenSession.resolveFeeToken({
          chainId: resolved.chainId,
          override: resolved.feeToken,
          paymentToken: resolved.token,
        })
        const result = await executeCredentialPlan(
          plan,
          AutoSwap.resolve(context?.autoSwap ?? autoSwapParameter, AutoSwap.defaultCurrencies),
          feeToken,
        )
        let { payload } = result
        if (machine && payload.action !== 'topUp') {
          if (payload.action === 'close') {
            const state = await Chain.getChannelState(
              plan.resolved.client,
              payload.channelId,
              plan.resolved.escrow,
            )
            if (state.deposit === 0n)
              throw new Error('Cannot authorize a machine-token refund for an empty channel.')
            // The refund authorization covers the full on-chain deposit, while
            // the close voucher remains the exact amount the merchant captures.
            const depositSignature =
              BigInt(payload.cumulativeAmount) === state.deposit
                ? payload.signature
                : (
                    await createVoucherPayload(
                      plan.resolved.client,
                      plan.account,
                      payload.descriptor,
                      state.deposit,
                      plan.resolved.chainId,
                      plan.resolved.escrow,
                    )
                  ).signature
            payload = { ...payload, refundSignature: depositSignature }
          }
          const authorizationSignature = await MachineTokenSession.signAuthorization(
            plan.resolved.client,
            plan.account,
            {
              authorization: {
                channelId: payload.channelId,
                cumulativeAmount: BigInt(payload.cumulativeAmount),
              },
              chainId: plan.resolved.chainId,
              router: plan.resolved.operator!,
            },
          )
          payload = { ...payload, authorizationSignature }
        }
        if (!(attempt && plan.type === 'open')) await commitEntry(result.entry)
        const credential = await serializeCredential(
          challenge,
          payload,
          resolved.chainId,
          plan.account,
        )
        if (attempt && plan.type === 'open' && result.entry) {
          const opened = result.entry
          attempt.settle = async (outcome) => {
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
                  await commitEntry(opened)
                }
              }
              return true
            } finally {
              release()
            }
          }
        } else release()
        return credential
      } catch (error) {
        release()
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
    const current = await store.get(entryKey(channel))
    const latest =
      current?.channelId.toLowerCase() === channel.channelId.toLowerCase() ? current : channel
    const updated = {
      ...latest,
      deposit: latest.deposit > nextDeposit ? latest.deposit : nextDeposit,
    }
    await store.set(updated)
    onChannelUpdate?.(updated)
  }

  MethodChallenge.register(method, async ({ challenge, context, fetch, input }) => {
    if (!isTip1034SessionChallenge(challenge)) return
    const sessionContext = context === undefined ? undefined : sessionContextSchema.parse(context)
    if (hasSessionAction(sessionContext)) return
    const direct = await resolveContext(challenge)
    const { entry: channel, resolved } = await resolveRail(direct, sessionContext).catch(() => ({
      entry: undefined,
      resolved: direct,
    }))
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
      const credentialContext = requireSessionCredentialContext(
        Credential.deserialize(credential).payload,
      )
      if (!isEventStream(response)) {
        if (
          credentialContext.action === 'open' &&
          headers.get('accept')?.toLowerCase().includes('text/event-stream')
        )
          return (await refetch?.()) ?? response
        return response
      }

      const resolvedContext = await resolveContext(challenge)
        .then(async (direct) => (await resolveMachineContext(direct, credentialContext)) ?? direct)
        .catch(() => undefined)
      const channel = resolvedContext ? await store.get(resolvedContext.key) : undefined
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
      /** Accept a noncanonical escrow contract advertised by the server. @default false */
      allowCustomEscrow?: boolean | undefined
      /** Automatically acquire the session currency from fallback stablecoins before open/top-up. */
      autoSwap?: AutoSwap.resolve.Value | undefined
      /** Pluggable persistence for reusable channels. Defaults to an in-memory store. */
      channelStore?: ChannelStore | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** Exact TIP20EscrowChannel address pin. Takes precedence over `allowCustomEscrow`. */
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
