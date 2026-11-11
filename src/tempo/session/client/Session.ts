import { type Address, parseUnits } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import type * as Challenge from '../../../Challenge.js'
import * as MethodChallenge from '../../../client/internal/MethodChallenge.js'
import * as MethodResponse from '../../../client/internal/MethodResponse.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import * as AcceptPayment from '../../../internal/AcceptPayment.js'
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
import {
  createChannelStore,
  entryKey,
  persistChannel,
  withFundingLock,
  type ChannelStore,
} from './ChannelStore.js'
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
import { getLockKeys, selectChannelContext } from './MachineToken.js'
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

/** Locks several payment scopes in a fixed order, so overlapping lock sets cannot deadlock. */
async function lockChannels(store: ChannelStore, keys: readonly string[]) {
  const releases: (() => void)[] = []
  for (const key of [...new Set(keys)].sort()) releases.push(await lockChannel(store, key))
  return () => {
    for (const release of releases.reverse()) release()
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

type SpendingPolicy = {
  currencies: readonly string[] | undefined
  expectedRecipients: ReadonlySet<string> | undefined
  maxAmount: bigint | undefined
  maxAtomicAmount: bigint | undefined
}

/** Validates and parses the client's session spending options once, at construction. */
function resolveSpendingPolicy(parameters: session.Parameters): SpendingPolicy {
  const { currencies, decimals, expectedRecipients, maxAmount, maxAtomicAmount } = parameters
  // Caps are denominated in the challenge currency, so they require a currency pin.
  if ((maxAmount !== undefined || maxAtomicAmount !== undefined) && currencies === undefined)
    throw new Error('Tempo session maxAmount and maxAtomicAmount require currencies.')
  return {
    currencies: currencies?.map((currency) => currency.toLowerCase()),
    expectedRecipients: expectedRecipients
      ? new Set(expectedRecipients.map((recipient) => recipient.toLowerCase()))
      : undefined,
    maxAmount: parseMaxAmount(maxAmount, decimals),
    maxAtomicAmount: maxAtomicAmount === undefined ? undefined : BigInt(maxAtomicAmount),
  }
}

/** Parses a display-unit cap, rejecting values that `parseUnits` would round. */
function parseMaxAmount(maxAmount: string | undefined, decimals: number | undefined) {
  if (maxAmount === undefined) return undefined
  if (decimals === undefined) throw new Error('Tempo session maxAmount requires currency decimals.')
  const fraction = maxAmount.split('.')[1]?.replace(/0+$/, '') ?? ''
  if (fraction.length > decimals)
    throw new Error(
      `Tempo session maxAmount ${maxAmount} has more fractional digits than ${decimals} decimals allow.`,
    )
  return parseUnits(maxAmount, decimals)
}

/**
 * Rejects a session challenge whose currency, recipient or per-unit amount violates the client
 * policy. Runs during challenge selection, in the automatic top-up hook, and before any signing work.
 */
function assertSpendingPolicy(
  policy: SpendingPolicy,
  request: { amount: string; currency: string; recipient?: string | undefined },
) {
  if (policy.currencies && !policy.currencies.includes(request.currency.toLowerCase()))
    throw new Error(`Tempo session currency is not allowed: ${request.currency}.`)
  // The recipient is the channel payee, so it must be one the client expects, as for charge.
  if (
    policy.expectedRecipients &&
    (!request.recipient || !policy.expectedRecipients.has(request.recipient.toLowerCase()))
  )
    throw new Error(`Unexpected session recipient: ${request.recipient}`)
  const amount = BigInt(request.amount)
  if (policy.maxAtomicAmount !== undefined && amount > policy.maxAtomicAmount)
    throw new Error('Tempo session amount exceeds maxAtomicAmount.')
  if (policy.maxAmount !== undefined && amount > policy.maxAmount)
    throw new Error('Tempo session amount exceeds maxAmount.')
}

/** Returns whether a session challenge satisfies the client policy. */
function satisfiesSpendingPolicy(
  policy: SpendingPolicy,
  request: { amount: string; currency: string; recipient?: string | undefined },
) {
  try {
    assertSpendingPolicy(policy, request)
    return true
  } catch {
    return false
  }
}

/** Returns whether a caller-supplied credential context asks to close a channel. */
function isExplicitClose(context: unknown) {
  return (
    typeof context === 'object' &&
    context !== null &&
    (context as { action?: unknown }).action === 'close'
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
    allowCustomEscrow = false,
    autoSwap: autoSwapParameter,
    channelStore,
    decimals = defaults.decimals,
    escrow: escrowOverride,
    allowedChainIds,
    getClient: getClientParameter,
    maxDeposit: maxDepositParameter,
    topUpAmount: topUpAmountParameter,
    onChannelUpdate,
    resolveAccount,
  } = parameters
  const policy = resolveSpendingPolicy(parameters)
  // A `currencies` allowlist without MACH keeps channels in the advertised currency.
  const machineTokenAllowed =
    !policy.currencies ||
    Object.values(defaults.machineToken).some((deployment) =>
      policy.currencies!.includes(deployment.token.toLowerCase()),
    )
  const withAllowedFunding = <challenge extends Challenge.Challenge>(challenge: challenge) =>
    machineTokenAllowed ? challenge : withoutMachineTokenDirect(challenge)
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
  const configuredOrigin = parameters.origin === undefined ? undefined : new URL(parameters.origin)
  if (configuredOrigin && !['http:', 'https:'].includes(configuredOrigin.protocol))
    throw new Error('Session origins require HTTP or HTTPS')
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

  const resolveCredentialPlan = async (
    resolved: ChallengeContext,
    context: CredentialContext | undefined,
    entry: ChannelEntry | undefined,
  ) =>
    planCredential({
      account: await resolveCredentialAccount(resolved, context, entry),
      entry,
      context,
      decimals,
      maxDeposit,
      resolved,
    })

  const method = Method.toClient(Methods.session, {
    // Skip offers that violate client policy so an acceptable offer can be chosen. An explicit
    // close, when the caller supplies it before selection, stays available for any offer. Flows
    // that learn the context only after selection defer the policy to createCredential.
    canHandleChallenge: ({ challenge, context }) =>
      isTip1034SessionChallenge(challenge) &&
      (isExplicitClose(context) ||
        context === AcceptPayment.deferredContext ||
        satisfiesSpendingPolicy(policy, challenge.request)),
    context: sessionContextSchema,
    async createCredential(parameters) {
      const { challenge, context } = parameters
      // Closing settles what the channel already spent, so it stays available for any offer.
      if (context?.action !== 'close') assertSpendingPolicy(policy, challenge.request)
      const challengeContext = await resolveChallengeContext({
        allowCustomEscrow,
        challenge: withAllowedFunding(challenge),
        escrowOverride,
        allowedChainIds,
        getClient,
      })
      const attempt = MethodResponse.getAttempt(parameters)
      const origin = MethodResponse.getOrigin(parameters) ?? configuredOrigin?.origin
      if (
        origin !== undefined &&
        (origin === 'null' || !['http:', 'https:'].includes(new URL(origin).protocol))
      )
        throw new Error('Session payments require an HTTP or HTTPS origin')
      if (configuredOrigin && origin !== configuredOrigin.origin)
        throw new Error('Session channel origin mismatch')
      const scopedSink = { ...sink, origin }
      let release = () => {}
      try {
        const automatic = !hasSessionAction(context) && context?.descriptor === undefined
        if (automatic) release = await lockChannels(store, getLockKeys(challengeContext))
        const resolved = await selectChannelContext({
          context,
          resolved: challengeContext,
          store,
        })
        if (automatic && attempt && (await store.get(resolved.key))?.opened) await attempt.prepare()
        let entry = await store.get(resolved.key)
        if (entry && entry.origin !== origin) throw new Error('Session channel origin mismatch')
        if (origin && !entry && resolved.snapshot && !context?.descriptor && !configuredOrigin)
          throw new Error(
            'Session snapshot recovery requires an explicitly configured origin or descriptor',
          )
        let plan = await resolveCredentialPlan(resolved, context, entry)
        if (!automatic && attempt && plan.type === 'open') {
          release = await lockChannels(store, getLockKeys(challengeContext))
          const nextEntry = await store.get(resolved.key)
          if (nextEntry && nextEntry.origin !== origin)
            throw new Error('Session channel origin mismatch')
          if (nextEntry?.channelId !== entry?.channelId) {
            entry = nextEntry
            if (entry?.opened) {
              await attempt.prepare()
              entry = await store.get(resolved.key)
            }
            plan = await resolveCredentialPlan(resolved, context, entry)
          }
        }
        let pendingOpen: ChannelEntry | undefined
        // Defer opens only when low-level Fetch owns the response lifecycle.
        // SessionManager unregisters this hook and keeps its existing transaction boundary.
        const credentialSink =
          attempt && plan.type === 'open'
            ? {
                store: {
                  get: (key: string) => store.get(key),
                  async set(next: ChannelEntry) {
                    pendingOpen = origin ? { ...next, origin } : next
                  },
                  delete: (key: string) => store.delete(key),
                },
                notifyUpdate() {},
              }
            : scopedSink
        const payload = await executeCredentialPlan(
          plan,
          credentialSink,
          AutoSwap.resolve(context?.autoSwap ?? autoSwapParameter, AutoSwap.defaultCurrencies),
        )
        const credential = await serializeCredential(
          challenge,
          payload,
          resolved.chainId,
          plan.account,
        )
        if (attempt && pendingOpen) {
          const opened = pendingOpen
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
                  await persistChannel(store, opened)
                  sink.notifyUpdate(opened)
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

  function createSessionCredential(
    challenge: TempoSessionChallenge,
    context: CredentialContext,
    input: RequestInfo | URL,
  ) {
    const parameters = { challenge, context }
    MethodResponse.attachOrigin(parameters, resolveInputOrigin(input))
    return method.createCredential(parameters)
  }

  const topUpChannelIfNeeded = async ({
    autoSwap,
    challenge,
    channel,
    deposit,
    fetch,
    input,
    requiredCumulative,
    signal,
  }: {
    autoSwap?: CredentialContext['autoSwap'] | undefined
    challenge: TempoSessionChallenge
    channel: ChannelEntry
    deposit: bigint
    fetch: typeof globalThis.fetch
    input: RequestInfo | URL
    requiredCumulative: bigint
    signal?: AbortSignal | undefined
  }) => {
    return withFundingLock(store, entryKey(channel), async () => {
      signal?.throwIfAborted()
      const fundingChannel = await store.get(entryKey(channel))
      if (fundingChannel?.channelId === channel.channelId) channel = fundingChannel
      if (channel.uncertainTopUp)
        throw new Error(
          'Session funding outcome is unknown; reconcile the pending payment before another top-up.',
        )
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
          autoSwap,
          additionalDeposit,
          challenge,
          channel,
          channelId: channel.channelId,
          createSessionCredential: (challenge, context) =>
            createSessionCredential(challenge, context, input),
          onUncertainFunding: async (entry) => {
            const current = await store.get(entryKey(entry))
            const unresolved = {
              ...(current?.channelId === entry.channelId ? current : entry),
              uncertainTopUp: true,
            }
            await persistChannel(store, unresolved)
            sink.notifyUpdate(unresolved)
          },
          fetch,
          input,
          signal,
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
      await persistChannel(store, updated)
      sink.notifyUpdate(updated)
    })
  }

  MethodChallenge.register(method, async ({ challenge, context, fetch, input, signal }) => {
    if (!isTip1034SessionChallenge(challenge)) return
    const sessionContext = context === undefined ? undefined : sessionContextSchema.parse(context)
    if (hasSessionAction(sessionContext)) return
    assertSpendingPolicy(policy, challenge.request)
    const resolved = await selectChannelContext({
      context: sessionContext,
      resolved: await resolveChallengeContext({
        allowCustomEscrow,
        challenge: withAllowedFunding(challenge),
        escrowOverride,
        allowedChainIds,
        getClient,
      }),
      store,
    })
    const channel = await store.get(resolved.key)
    if (!channel?.opened) return
    const origin = resolveInputOrigin(input)
    if (channel.origin !== origin) throw new Error('Session channel origin mismatch')
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
      autoSwap: sessionContext?.autoSwap,
      challenge,
      channel,
      deposit,
      fetch,
      input,
      requiredCumulative,
      signal,
    })
  })

  return MethodResponse.register(
    method,
    async ({
      challenge,
      context,
      credential,
      fetch,
      headers,
      input,
      refetch,
      response,
      signal,
    }) => {
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
        await selectChannelContext({
          context: sessionContextSchema.safeParse(context).data,
          resolved: await resolveChallengeContext({
            allowCustomEscrow,
            challenge: withAllowedFunding(challenge),
            escrowOverride,
            allowedChainIds,
            getClient,
          }),
          store,
        })
      ).key
      let channel = await store.get(channelKey)
      const driver = {
        assertVoucherWithinLocalLimit: (cumulativeAmount) =>
          assertWithinMaxDeposit(cumulativeAmount, maxDeposit),
        createSessionCredential: (challenge, context) =>
          createSessionCredential(challenge, context, input),
        fetch,
        getChannel: () => channel ?? null,
        async topUpIfNeeded({ deposit, requiredCumulative, signal: topUpSignal }) {
          if (!channel) return
          await topUpChannelIfNeeded({
            autoSwap:
              context === undefined ? undefined : sessionContextSchema.parse(context).autoSwap,
            challenge,
            channel,
            deposit: channel.deposit > deposit ? channel.deposit : deposit,
            fetch,
            input,
            requiredCumulative,
            signal: topUpSignal,
          })
        },
      } satisfies SsePaymentDriver

      return wrapSseResponse({
        onNeedVoucher: (event, streamSignal) =>
          handleSseNeedVoucher({ challenge, driver, headers, input, signal: streamSignal }, event),
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
      /**
       * HTTP origin authorized for credential creation and server-snapshot recovery.
       * Fetch supplies the request origin, but recovering an unknown channel from its snapshot
       * requires this explicit origin pin or a caller-supplied descriptor.
       */
      origin?: string | undefined
      /**
       * Pluggable persistence for reusable channels. Defaults to an in-memory store.
       * Use a separate store per HTTP origin: each payment scope holds one channel, and a
       * channel already bound to another origin is rejected rather than overwritten or reused.
       */
      channelStore?: ChannelStore | undefined
      /**
       * Allowlist of TIP-20 currency addresses this client will pay sessions in, compared
       * case-insensitively. Offers in other currencies are skipped during selection and
       * rejected before signing; an empty list rejects all. Required with `maxAmount` or
       * `maxAtomicAmount`, which are denominated in the challenge currency.
       */
      currencies?: readonly Address[] | undefined
      /**
       * Allowlist of session recipients (the channel payee), compared case-insensitively. Offers
       * to other recipients, or without one, are skipped during selection and rejected before
       * signing, as for charge. Explicit closes are exempt.
       */
      expectedRecipients?: readonly Address[] | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). `maxAmount` requires it explicitly. */
      decimals?: number | undefined
      /** Exact TIP20EscrowChannel address pin. Takes precedence over `allowCustomEscrow`. */
      escrow?: Address | undefined
      /**
       * Chains permitted for session credentials. Omitted allows any chain; empty rejects all.
       * A single entry supplies the chain when omitted by the challenge. Otherwise the
       * challenge or resolved client must select an allowed chain.
       */
      allowedChainIds?: readonly number[] | undefined
      /**
       * Maximum display-unit amount (e.g. `'1.5'`) the client is willing to pay per session
       * unit (the challenge `amount`), parsed with an explicit `decimals`. Values with more
       * fractional digits than `decimals` are rejected rather than rounded. Larger offers are
       * skipped during selection and rejected before signing. Requires `currencies`.
       */
      maxAmount?: string | undefined
      /**
       * Maximum amount the client is willing to pay per session unit, in raw base units of the
       * challenge currency. Checked like `maxAmount`. Requires `currencies`.
       */
      maxAtomicAmount?: string | undefined
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

function resolveInputOrigin(input: RequestInfo | URL): string {
  const url = new URL(
    input instanceof Request ? input.url : input,
    typeof globalThis.location === 'undefined' ? undefined : globalThis.location.href,
  )
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Session payments require an HTTP or HTTPS origin')
  return url.origin
}

/** Returns a challenge without `machineTokenDirect`, so its channel opens in the advertised currency. */
function withoutMachineTokenDirect<challenge extends Challenge.Challenge>(
  challenge: challenge,
): challenge {
  const methodDetails = challenge.request.methodDetails
  if (typeof methodDetails !== 'object' || methodDetails === null) return challenge
  const { machineTokenDirect: _, ...rest } = methodDetails as Record<string, unknown>
  return { ...challenge, request: { ...challenge.request, methodDetails: rest } }
}
