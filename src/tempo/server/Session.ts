/**
 * Server-side session payment method for request/response flows.
 *
 * Handles the full channel lifecycle (open, voucher, top-up, close) and
 * one-shot settlement. Each incoming request carries a session credential
 * with a cumulative voucher that the server validates and records.
 *
 * Use `session()` for standard HTTP request/response patterns where each
 * request is a discrete paid unit (for example, a page scrape or API call).
 * For long-lived connections that emit multiple paid events over a single
 * request, use {@link ../session/Sse} instead.
 */
import {
  type Address,
  type Hex,
  parseUnits,
  type Account as viem_Account,
  type Client as viem_Client,
} from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import {
  AmountExceedsDepositError,
  BadRequestError,
  ChannelClosedError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InsufficientBalanceError,
  InvalidSignatureError,
  VerificationFailedError,
} from '../../Errors.js'
import type { Challenge, Credential } from '../../index.js'
import type { LooseOmit } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import * as Account from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import {
  broadcastOpenTransaction,
  broadcastTopUpTransaction,
  closeOnChain,
  getOnChainChannel,
  type OnChainChannel,
  settleOnChain,
} from '../session/Chain.js'
import * as ChannelStore from '../session/ChannelStore.js'
import { createSessionReceipt } from '../session/Receipt.js'
import type { SessionCredentialPayload, SessionReceipt, SignedVoucher } from '../session/Types.js'
import { parseVoucherFromPayload, verifyVoucher } from '../session/Voucher.js'
import * as Transport from './internal/transport.js'

/** Challenge methodDetails shape for session methods. */
type SessionMethodDetails = {
  escrowContract: Address
  chainId: number
  channelId?: Hex | undefined
  minVoucherDelta?: string | undefined
  feePayer?: boolean | undefined
}

/**
 * Creates a session payment server using the Method.toServer() pattern.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     tempo.session({
 *       store: myStore,
 *       recipient: '0x...',
 *       currency: '0x...',
 *       escrowContract: '0x...',
 *     }),
 *   ],
 *   realm: 'my-app',
 *   secretKey: '...',
 * })
 * ```
 */
export function session<const parameters extends session.Parameters>(p?: parameters) {
  const parameters = p as parameters
  const {
    amount,
    channelStateTtl = 5_000,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    store: rawStore = Store.memory(),
    suggestedDeposit,
    unitType,
    waitForConfirmation = true,
  } = parameters

  const lastOnChainVerified = new Map<Hex, number>()

  const store = ChannelStore.fromStore(rawStore)

  const { account, recipient, feePayer, feePayerUrl } = Account.resolve(parameters)

  if (!account)
    throw new Error(
      'tempo.session() requires an `account` (viem Account, e.g. privateKeyToAccount("0x...")). An address string is not sufficient — the server needs a signing account for on-chain channel close and settlement.',
    )

  const getClient = Client.getResolver({
    chain: tempo_chain,
    feePayerUrl,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Transport = parameters['sse'] extends false | undefined ? undefined : Transport.Sse
  const transport = parameters.sse
    ? Transport.sse({
        store,
        ...(typeof parameters.sse === 'object' ? parameters.sse : undefined),
      })
    : undefined

  type Defaults = session.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.session, Defaults, Transport>(Methods.session, {
    defaults: {
      amount,
      currency,
      decimals,
      recipient,
      suggestedDeposit,
      unitType,
    } as unknown as Defaults,

    transport: transport as never,

    // TODO: dedupe `{charge,session}.request`
    async request({ credential, request }) {
      // Extract chainId from request or default.
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.testnet) return defaults.chainId.testnet
        return (await getClient({})).chain?.id
      })()

      // Validate chainId.
      const client = await (async () => {
        try {
          return await getClient({ chainId })
        } catch {
          throw new Error(`No client configured with chainId ${chainId}.`)
        }
      })()
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)

      const resolvedEscrow =
        request.escrowContract ??
        parameters.escrowContract ??
        defaults.escrowContract[chainId as keyof typeof defaults.escrowContract]

      // Extract feePayer.
      const resolvedFeePayer = (() => {
        const account = typeof request.feePayer === 'object' ? request.feePayer : feePayer
        const requested = request.feePayer !== false && (account ?? feePayer ?? feePayerUrl)
        if (credential) return account
        if (requested) return true
        return undefined
      })()

      return {
        ...request,
        chainId,
        escrowContract: resolvedEscrow,
        feePayer: resolvedFeePayer,
      }
    },

    async verify({ credential }) {
      const { challenge, payload } = credential as Credential.Credential<SessionCredentialPayload>

      const methodDetails = challenge.request.methodDetails as SessionMethodDetails
      const client = await getClient({ chainId: methodDetails.chainId })

      const resolvedFeePayer = methodDetails.feePayer === true ? feePayer : undefined
      const minVoucherDelta = parseUnits(parameters.minVoucherDelta ?? '0', decimals)
      const effectiveMinVoucherDelta = methodDetails.minVoucherDelta
        ? BigInt(methodDetails.minVoucherDelta)
        : minVoucherDelta

      let sessionReceipt: SessionReceipt

      switch (payload.action) {
        case 'open':
          sessionReceipt = await handleOpen(
            store,
            client,
            challenge,
            payload,
            methodDetails,
            resolvedFeePayer,
            waitForConfirmation,
          )
          lastOnChainVerified.set(payload.channelId, Date.now())
          break

        case 'topUp':
          sessionReceipt = await handleTopUp(
            store,
            client,
            challenge,
            payload,
            methodDetails,
            resolvedFeePayer,
          )
          lastOnChainVerified.set(payload.channelId, Date.now())
          break

        case 'voucher':
          sessionReceipt = await handleVoucher(
            store,
            client,
            effectiveMinVoucherDelta,
            challenge,
            payload,
            methodDetails,
            channelStateTtl,
            lastOnChainVerified,
          )
          break

        case 'close':
          sessionReceipt = await handleClose(
            store,
            client,
            challenge,
            payload,
            methodDetails,
            account,
            resolvedFeePayer,
          )
          break

        default:
          throw new BadRequestError({
            reason: `unknown action: ${(payload as { action: string }).action}`,
          })
      }

      return sessionReceipt
    },

    // This hook acts as a gate: when it returns a Response, `withReceipt()`
    // in Mppx.ts short-circuits and returns that response directly without
    // invoking the user's route handler. When it returns undefined, the
    // user's handler runs normally and serves content.
    //
    // close and topUp are always gated (204) — they are pure management.
    //
    // open and voucher are gated only for bodyless POSTs (management
    // updates). POSTs with a body are content requests — the client's
    // original request piggybacked on the credential — so they fall
    // through to serve content. GETs always fall through so auto-mode
    // clients (whose fetch wrapper bundles open+voucher into a single
    // GET retry) receive content as expected.
    respond({ credential, input }) {
      const { payload } = credential as Credential.Credential<SessionCredentialPayload>

      if (payload.action === 'close') return new Response(null, { status: 204 })
      if (payload.action === 'topUp') return new Response(null, { status: 204 })

      // open and voucher: gate only bodyless POSTs (management updates).
      // POSTs with a body are content requests — fall through so the
      // upstream response is returned to the client.
      if (input.method === 'POST') {
        const contentLength = input.headers.get('content-length')
        if (contentLength !== null && contentLength !== '0') return undefined
        if (input.headers.has('transfer-encoding')) return undefined
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
}

export declare namespace session {
  type Defaults = LooseOmit<
    Method.RequestDefaults<typeof Methods.session>,
    'feePayer' | 'recipient'
  >

  type Parameters = {
    /** TTL in milliseconds for cached on-chain channel state. After this duration, the server re-queries on-chain state during voucher handling to detect forced close requests. @default 5_000 */
    channelStateTtl?: number | undefined
    /** Minimum voucher delta to accept (numeric string, default: "0"). */
    minVoucherDelta?: string | undefined
    /**
     * Whether to wait for the open transaction to confirm on-chain before
     * responding. @default true
     *
     * When `false`, the transaction is simulated via `eth_estimateGas` and
     * broadcast without waiting for inclusion. The receipt will optimistically
     * report `status: 'success'` based on simulation alone — if the
     * transaction reverts on-chain after broadcast (e.g. due to a state
     * change between simulation and inclusion), the receipt will not reflect
     * the failure.
     */
    waitForConfirmation?: boolean | undefined
    /** Store backend for channel state. */
    store?: Store.Store | undefined
    /**
     * Enable SSE streaming.
     *
     * Pass `true` to enable with defaults, or an options object
     * to configure SSE (e.g. `{ poll: true }` for
     * Cloudflare Workers compatibility).
     */
    sse?: boolean | Transport.sse.Options | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
  } & Account.resolve.Parameters &
    Client.getResolver.Parameters &
    Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
    escrowContract: Address
  }
}

/**
 * One-shot settle: reads highest voucher from store and submits on-chain.
 */
export async function settle(
  store: ChannelStore.ChannelStore,
  client: viem_Client,
  channelId: Hex,
  options?: {
    escrowContract?: Address | undefined
    feePayer?: viem_Account | undefined
    account?: viem_Account | undefined
  },
): Promise<Hex> {
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!channel.highestVoucher) throw new VerificationFailedError({ reason: 'no voucher to settle' })

  const chainId = client.chain?.id
  const resolvedEscrow =
    options?.escrowContract ??
    defaults.escrowContract[chainId as keyof typeof defaults.escrowContract]
  if (!resolvedEscrow) throw new Error(`No escrow contract for chainId ${chainId}.`)

  const settledAmount = channel.highestVoucher.cumulativeAmount
  const txHash = await settleOnChain(
    client,
    resolvedEscrow,
    channel.highestVoucher,
    options?.feePayer,
    options?.account,
  )

  await store.updateChannel(channelId, (current) => {
    if (!current) return null
    const nextSettled =
      settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
    return { ...current, settledOnChain: nextSettled }
  })

  return txHash
}

/**
 * Charge against a channel's balance.
 *
 * Exported so consumers can deduct from a channel outside the `session()`
 * handler (e.g., custom middleware, the SSE `serve()` loop, or direct tests).
 *
 * Delegates to the shared `deductFromChannel` atomic helper and translates
 * failure modes into typed errors (`InsufficientBalanceError`, `ChannelClosedError`).
 */
export async function charge(
  store: ChannelStore.ChannelStore,
  channelId: Hex,
  amount: bigint,
): Promise<ChannelStore.State> {
  let result: Awaited<ReturnType<typeof ChannelStore.deductFromChannel>>
  try {
    result = await ChannelStore.deductFromChannel(store, channelId, amount)
  } catch {
    throw new ChannelClosedError({ reason: 'channel not found' })
  }
  if (!result.ok) {
    const available = result.channel.highestVoucherAmount - result.channel.spent
    throw new InsufficientBalanceError({
      reason: `requested ${amount}, available ${available}`,
    })
  }
  return result.channel
}

/**
 * Validate on-chain channel state.
 */
function validateOnChainChannel(
  onChain: OnChainChannel,
  recipient: Address,
  currency: Address,
  amount?: bigint,
): void {
  if (onChain.deposit === 0n) {
    throw new ChannelNotFoundError({ reason: 'channel not funded on-chain' })
  }
  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }
  if (onChain.closeRequestedAt !== 0n) {
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }
  if (onChain.payee.toLowerCase() !== recipient.toLowerCase()) {
    throw new VerificationFailedError({
      reason: 'on-chain payee does not match server destination',
    })
  }
  if (onChain.token.toLowerCase() !== currency.toLowerCase()) {
    throw new VerificationFailedError({ reason: 'on-chain token does not match server token' })
  }
  if (amount !== undefined && onChain.deposit - onChain.settled < amount) {
    throw new InsufficientBalanceError({
      reason: 'channel available balance insufficient for requested amount',
    })
  }
}

/**
 * Shared logic for verifying an incremental voucher and updating channel state.
 * Used by both handleVoucher and (indirectly) handleOpen.
 */
async function verifyAndAcceptVoucher(parameters: {
  store: ChannelStore.ChannelStore
  minVoucherDelta: bigint
  challenge: Challenge.Challenge
  channel: ChannelStore.State
  channelId: Hex
  voucher: SignedVoucher
  onChain: OnChainChannel
  methodDetails: SessionMethodDetails
}): Promise<SessionReceipt> {
  const { store, minVoucherDelta, challenge, channel, channelId, voucher, onChain, methodDetails } =
    parameters

  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }
  if (onChain.closeRequestedAt !== 0n) {
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }

  if (voucher.cumulativeAmount <= onChain.settled) {
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  }

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  }

  if (voucher.cumulativeAmount < channel.highestVoucherAmount) {
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount must be strictly greater than highest accepted voucher',
    })
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )

  if (!isValid) {
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  }

  // Idempotent replay: equal cumulative voucher is accepted without
  // advancing channel state or charging additional value.
  if (voucher.cumulativeAmount === channel.highestVoucherAmount) {
    return createSessionReceipt({
      challengeId: challenge.id,
      channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
  }

  const delta = voucher.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta) {
    throw new DeltaTooSmallError({
      reason: `voucher delta ${delta} below minimum ${minVoucherDelta}`,
    })
  }

  const updated = await store.updateChannel(channelId, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
    if (voucher.cumulativeAmount > current.highestVoucherAmount) {
      return {
        ...current,
        deposit: onChain.deposit,
        highestVoucherAmount: voucher.cumulativeAmount,
        highestVoucher: voucher,
      }
    }
    return current
  })
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })

  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
  })
}

/**
 * Handle 'open' action - verify voucher, create channel, and broadcast.
 *
 * When `waitForConfirmation` is true (default), the open transaction is
 * broadcast and confirmed on-chain before responding. When false, the
 * transaction is validated and simulated via `eth_estimateGas`; the receipt
 * is returned immediately and the broadcast runs in the background.
 */
async function handleOpen(
  store: ChannelStore.ChannelStore,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: SessionCredentialPayload & { action: 'open' },
  methodDetails: SessionMethodDetails,
  feePayer: viem_Account | undefined,
  waitForConfirmation: boolean,
): Promise<SessionReceipt> {
  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  const recipient = challenge.request.recipient as Address
  const currency = challenge.request.currency as Address
  const amount = challenge.request.amount ? BigInt(challenge.request.amount as string) : undefined

  const { onChain, txHash } = await broadcastOpenTransaction({
    client,
    serializedTransaction: payload.transaction,
    escrowContract: methodDetails.escrowContract,
    channelId: payload.channelId,
    recipient,
    currency,
    feePayer,
    waitForConfirmation,
  })

  validateOnChainChannel(onChain, recipient, currency, amount)

  const authorizedSigner =
    onChain.authorizedSigner === '0x0000000000000000000000000000000000000000'
      ? onChain.payer
      : onChain.authorizedSigner

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  }

  if (voucher.cumulativeAmount <= onChain.settled) {
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    authorizedSigner,
  )

  if (!isValid) {
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  }

  const updated = await store.updateChannel(payload.channelId, (existing) => {
    if (existing) {
      if (voucher.cumulativeAmount <= existing.settledOnChain) {
        throw new VerificationFailedError({
          reason: 'voucher amount is below settled on-chain amount',
        })
      }

      const settledOnChain =
        onChain.settled > existing.settledOnChain ? onChain.settled : existing.settledOnChain
      const spent = settledOnChain > existing.spent ? settledOnChain : existing.spent

      if (voucher.cumulativeAmount > existing.highestVoucherAmount) {
        return {
          ...existing,
          deposit: onChain.deposit,
          settledOnChain,
          spent,
          highestVoucherAmount: voucher.cumulativeAmount,
          highestVoucher: voucher,
          authorizedSigner,
        }
      }
      return {
        ...existing,
        deposit: onChain.deposit,
        settledOnChain,
        spent,
        authorizedSigner,
      }
    }
    return {
      channelId: payload.channelId,
      chainId: methodDetails.chainId,
      escrowContract: methodDetails.escrowContract,
      closeRequestedAt: onChain.closeRequestedAt,
      payer: onChain.payer,
      payee: onChain.payee,
      token: onChain.token,
      authorizedSigner,
      deposit: onChain.deposit,
      settledOnChain: onChain.settled,
      highestVoucherAmount: voucher.cumulativeAmount,
      highestVoucher: voucher,
      spent: onChain.settled,
      units: 0,
      finalized: false,
      createdAt: new Date().toISOString(),
    }
  })

  if (!updated) throw new VerificationFailedError({ reason: 'failed to create channel' })

  return createSessionReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
    txHash,
  })
}

/**
 * Handle 'topUp' action - broadcast topUp transaction and update channel deposit.
 *
 * Per spec Section 8.3.2, topUp payloads contain only the transaction and
 * additionalDeposit — no voucher. The client must send a separate 'voucher'
 * action to authorize spending the new funds.
 */
async function handleTopUp(
  store: ChannelStore.ChannelStore,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: SessionCredentialPayload & { action: 'topUp' },
  methodDetails: SessionMethodDetails,
  feePayer: viem_Account | undefined,
): Promise<SessionReceipt> {
  const channel = await store.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }

  const declaredDeposit = BigInt(payload.additionalDeposit)

  const { newDeposit: onChainDeposit } = await broadcastTopUpTransaction({
    client,
    serializedTransaction: payload.transaction,
    escrowContract: methodDetails.escrowContract,
    channelId: payload.channelId,
    currency: challenge.request.currency as Address,
    declaredDeposit,
    previousDeposit: channel.deposit,
    feePayer,
  })

  const updated = await store.updateChannel(payload.channelId, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
    return { ...current, deposit: onChainDeposit }
  })

  return createSessionReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: updated?.highestVoucherAmount ?? channel.highestVoucherAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
  })
}

/**
 * Handle 'voucher' action - verify and accept a new voucher.
 */
async function handleVoucher(
  store: ChannelStore.ChannelStore,
  client: viem_Client,
  minVoucherDelta: bigint,
  challenge: Challenge.Challenge,
  payload: SessionCredentialPayload & { action: 'voucher' },
  methodDetails: SessionMethodDetails,
  channelStateTtl: number,
  lastOnChainVerified: Map<Hex, number>,
): Promise<SessionReceipt> {
  const channel = await store.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }
  if (channel.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized' })
  }

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  // Use locally-stored channel state as a trusted cache instead of
  // reading on-chain for every voucher. The on-chain state is verified
  // during `open` and `topUp` actions — subsequent vouchers within the
  // same session can safely use the cached deposit/signer values.
  // This avoids an RPC round-trip per voucher, which is critical for
  // high-frequency SSE streaming where vouchers arrive per-token.
  //
  // To guard against the payer initiating a forced close while vouchers
  // are still being accepted, re-query on-chain state when the cache
  // exceeds the configured staleness TTL (default: 5s).
  const lastVerified = lastOnChainVerified.get(payload.channelId) ?? 0
  const isStale = Date.now() - lastVerified > channelStateTtl

  const onChain = await (async () => {
    if (isStale) {
      const onChainChannel = await getOnChainChannel(
        client,
        methodDetails.escrowContract,
        payload.channelId,
      )
      lastOnChainVerified.set(payload.channelId, Date.now())
      // Persist closeRequestedAt so the cached path detects force-close
      // between re-queries.
      if (onChainChannel.closeRequestedAt !== 0n) {
        await store.updateChannel(payload.channelId, (current) =>
          current ? { ...current, closeRequestedAt: onChainChannel.closeRequestedAt } : current,
        )
      }
      return onChainChannel
    }
    return {
      finalized: channel.finalized,
      closeRequestedAt: channel.closeRequestedAt,
      payer: channel.payer,
      payee: channel.payee,
      token: channel.token,
      authorizedSigner: channel.authorizedSigner,
      deposit: channel.deposit,
      settled: channel.settledOnChain,
    }
  })()

  return verifyAndAcceptVoucher({
    store,
    minVoucherDelta,
    challenge,
    channel,
    channelId: payload.channelId,
    voucher,
    onChain,
    methodDetails,
  })
}

/**
 * Handle 'close' action - verify final voucher and close channel.
 */
async function handleClose(
  store: ChannelStore.ChannelStore,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: SessionCredentialPayload & { action: 'close' },
  methodDetails: SessionMethodDetails,
  account?: viem_Account,
  feePayer?: viem_Account,
): Promise<SessionReceipt> {
  const channel = await store.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }
  if (channel.finalized) {
    throw new ChannelClosedError({ reason: 'channel is already finalized' })
  }

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  const onChain = await getOnChainChannel(client, methodDetails.escrowContract, payload.channelId)

  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }

  const minCloseAmount = channel.spent > onChain.settled ? channel.spent : onChain.settled
  if (voucher.cumulativeAmount < minCloseAmount) {
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${minCloseAmount} (max of spent and on-chain settled)`,
    })
  }

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({
      reason: 'close voucher amount exceeds on-chain deposit',
    })
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )

  if (!isValid) {
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  }

  const txHash = await closeOnChain(
    client,
    methodDetails.escrowContract,
    voucher,
    account,
    feePayer,
  )

  const updated = await store.updateChannel(payload.channelId, (current) => {
    if (!current) return null
    const updateVoucher = voucher.cumulativeAmount > current.highestVoucherAmount
    return {
      ...current,
      deposit: onChain.deposit,
      ...(updateVoucher && {
        highestVoucherAmount: voucher.cumulativeAmount,
        highestVoucher: voucher,
      }),
      finalized: true,
    }
  })

  return createSessionReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    ...(txHash !== undefined && { txHash }),
  })
}
