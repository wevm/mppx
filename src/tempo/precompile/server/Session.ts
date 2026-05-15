/**
 * Server-side TIP-1034 precompile session payment method for request/response flows.
 *
 * Handles the full TIP20EscrowChannel lifecycle (open, voucher, top-up, close)
 * and one-shot settlement. Each incoming request carries a session credential
 * with a cumulative voucher that the server validates and records.
 */
import {
  type Address,
  type Hex,
  isAddressEqual,
  parseUnits,
  zeroAddress,
  type Account as viem_Account,
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
} from '../../../Errors.js'
import type { Challenge, Credential } from '../../../index.js'
import type { LooseOmit, NoExtraKeys } from '../../../internal/types.js'
import * as Method from '../../../Method.js'
import * as Store from '../../../Store.js'
import * as Client from '../../../viem/Client.js'
import type * as z from '../../../zod.js'
import * as defaults from '../../internal/defaults.js'
import * as FeePayer from '../../internal/fee-payer.js'
import type * as types from '../../internal/types.js'
import * as Methods from '../../Methods.js'
import {
  captureRequestBodyProbe,
  isSessionContentRequest,
} from '../../server/internal/request-body.js'
import * as Transport from '../../server/internal/transport.js'
import type { SessionMethodDetails } from '../../server/Session.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import { createSessionReceipt } from '../../session/Receipt.js'
import type { SessionReceipt } from '../../session/Types.js'
import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { type SessionCredentialPayload, type SignedVoucher, uint96 } from '../Types.js'
import * as Voucher from '../Voucher.js'

/** Creates a server-side TIP20EscrowChannel precompile session payment method. */
export function session<const parameters extends session.Parameters>(
  p?: NoExtraKeys<parameters, session.Parameters>,
) {
  const parameters = p as parameters
  const {
    amount,
    channelStateTtl = 5_000,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    store: rawStore = Store.memory(),
    suggestedDeposit,
    unitType,
  } = parameters

  const store = ChannelStore.fromStore(rawStore as never)
  const lastOnChainVerified = new Map<Hex, number>()
  const recipient = parameters.recipient as Address
  const getClient = Client.getResolver({
    chain: tempo_chain,
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

    // TODO: dedupe `{charge,session}.request`
    transport: transport as never,

    async request({ credential, request }) {
      // Extract chainId from request or default.
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.chainId) return parameters.chainId
        return (await getClient({})).chain?.id
      })()
      if (!chainId) throw new Error('No chainId configured for tempo.precompile.session().')

      // Validate chainId.
      const client = await getClient({ chainId })
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)
      // Extract feePayer.
      const resolvedFeePayer = (() => {
        if (request.feePayer === false) return credential ? false : undefined
        const account =
          typeof request.feePayer === 'object' ? request.feePayer : parameters.feePayer
        if (credential) return account ?? undefined
        if (account) return true
        return undefined
      })()
      return {
        ...request,
        chainId,
        escrowContract: request.escrowContract ?? parameters.escrowContract ?? tip20ChannelEscrow,
        feePayer: resolvedFeePayer,
      }
    },

    async verify({ credential, envelope, request }) {
      const { challenge, payload: rawPayload } = credential
      const payload = rawPayload as SessionCredentialPayload
      const resolvedRequest = (() => {
        const parsed = Methods.session.schema.request.safeParse(request)
        if (parsed.success) return parsed.data
        // verifyCredential() passes the HMAC-bound challenge request, which is
        // already in canonical output form and should not be transformed again.
        return request as unknown as z.output<typeof Methods.session.schema.request>
      })()
      const methodDetails = resolvedRequest.methodDetails as SessionMethodDetails | undefined
      if (!methodDetails) throw new VerificationFailedError({ reason: 'missing methodDetails' })
      const chainId = methodDetails.chainId
      const escrow = methodDetails.escrowContract
      const client = await getClient({ chainId })
      const requestAllowsFeePayer =
        request.feePayer !== false &&
        (request.feePayer === undefined ||
          request.feePayer === true ||
          typeof request.feePayer === 'object')
      const resolvedFeePayer =
        methodDetails.feePayer === true && requestAllowsFeePayer
          ? typeof request.feePayer === 'object'
            ? request.feePayer
            : parameters.feePayer
          : undefined
      const minVoucherDelta = methodDetails.minVoucherDelta
        ? BigInt(methodDetails.minVoucherDelta)
        : parseUnits(parameters.minVoucherDelta ?? '0', decimals)

      let sessionReceipt: SessionReceipt

      switch (payload.action) {
        case 'open': {
          sessionReceipt = await handleOpen({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            feePayer: resolvedFeePayer,
            feePayerPolicy: parameters.feePayerPolicy,
          })
          lastOnChainVerified.set(sessionReceipt.channelId as Hex, Date.now())
          break
        }
        case 'topUp': {
          sessionReceipt = await handleTopUp({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            feePayer: resolvedFeePayer,
            feePayerPolicy: parameters.feePayerPolicy,
          })
          lastOnChainVerified.set(sessionReceipt.channelId as Hex, Date.now())
          break
        }
        case 'voucher': {
          sessionReceipt = await handleVoucher({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            channelStateTtl,
            lastOnChainVerified,
            minVoucherDelta,
          })
          break
        }
        case 'close': {
          sessionReceipt = await handleClose({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            account: parameters.account,
            feePayer: resolvedFeePayer,
            feePayerPolicy: parameters.feePayerPolicy,
            feeToken: parameters.feeToken,
          })
          break
        }
        default:
          throw new VerificationFailedError({ reason: 'unsupported precompile session action' })
      }

      // In the default HTTP request/response mode, each successful content
      // request consumes one unit immediately after the credential is accepted.
      // This keeps equal-voucher replays bounded by the voucher's remaining
      // balance instead of serving repeated responses for free.
      if (
        envelope &&
        isSessionContentRequest(envelope.capturedRequest) &&
        (payload.action === 'open' || payload.action === 'voucher')
      ) {
        const charged = await charge(
          store,
          sessionReceipt.channelId as Hex,
          BigInt(resolvedRequest.amount ?? challenge.request.amount),
        )
        sessionReceipt = {
          ...sessionReceipt,
          spent: charged.spent.toString(),
          units: charged.units,
        }
        if (parameters.sse) sessionReceipt = Transport.markPrepaidSessionTick(sessionReceipt)
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
    // open and voucher share the same captured-request classifier used
    // during verification. Non-billable requests are treated as management
    // updates; billable requests fall through to the application handler.
    respond({ credential, envelope, input }) {
      const { payload } = credential as Credential.Credential<SessionCredentialPayload>

      if (payload.action === 'close') return new Response(null, { status: 204 })
      if (payload.action === 'topUp') return new Response(null, { status: 204 })

      const request = envelope?.capturedRequest ?? captureRequestBodyProbe(input)
      if (isSessionContentRequest(request)) return undefined
      return new Response(null, { status: 204 })
    },
  })
}

export namespace session {
  export type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.session>, 'feePayer'>

  export type FeePayerPolicy = Partial<FeePayer.Policy>

  export type Parameters = {
    /** TTL in milliseconds for cached on-chain channel state. After this duration, the server re-queries on-chain state during voucher handling to detect forced close requests. @default 5_000 */
    channelStateTtl?: number | undefined
    /** Override the fee-sponsor policy used for sponsored open/topUp transactions and server-driven close transactions. */
    feePayerPolicy?: FeePayerPolicy | undefined
    /** Minimum voucher delta to accept (numeric string, default: "0"). */
    minVoucherDelta?: string | undefined
    /**
     * Atomic store backend for channel state.
     *
     * Session mutations must be linearizable across instances so spent,
     * highest-voucher, top-up, and close/finalization updates cannot race.
     * Use `Store.memory()` for tests or local single-process usage.
     */
    store?: Store.AtomicStore | undefined
    /** Enable SSE streaming. Pass `true` for defaults or an options object to configure SSE. */
    sse?: boolean | Transport.sse.Options | undefined
    /** Tempo chain ID used for TIP-1034 channel escrow challenges. Defaults to the resolved client chain ID. Pass the Tempo testnet chain ID here instead of using legacy session's `testnet` boolean. */
    chainId?: number | undefined

    /** Account used for server-driven close and settle transactions. Defaults to the client account. */
    account?: viem_Account | undefined
    /** Optional fee payer used to sponsor server-driven close transactions. */
    feePayer?: viem_Account | undefined
    /** Optional fee token used for server-driven close transactions. */
    feeToken?: Address | undefined
  } & Client.getResolver.Parameters &
    Defaults

  export type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  >
}

function assertSettlementSender(parameters: {
  operation: 'close' | 'settle'
  channelId: Hex
  operator: Address
  payee: Address
  sender: Address | undefined
}) {
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

/** Settles the highest accepted voucher for a precompile-backed session channel. */
export async function settle(
  store_: Store.Store<any> | ChannelStore.ChannelStore,
  client: Chain.TransactionClient,
  channelId_: Hex,
  options?: {
    account?: viem_Account | undefined
    candidateFeeTokens?: readonly Address[] | undefined
    escrowContract?: Address | undefined
    feePayer?: viem_Account | undefined
    feePayerPolicy?: session.FeePayerPolicy | undefined
    feeToken?: Address | undefined
  },
): Promise<Hex> {
  const store = 'getChannel' in store_ ? store_ : ChannelStore.fromStore(store_ as never)
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
  const settled = Chain.getChannelEvent(receipt, 'Settled', channelId)
  const newSettled = uint96(settled.args.newSettled as bigint)
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
        }
      : current,
  )
  return txHash
}

/**
 * Charge against a precompile-backed channel's balance.
 *
 * Exported so consumers can deduct from a channel outside the `session()`
 * handler.
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

function authorizedSigner(descriptor: Channel.ChannelDescriptor): Address {
  return isAddressEqual(descriptor.authorizedSigner, zeroAddress)
    ? descriptor.payer
    : descriptor.authorizedSigner
}

function getClientAccount(client: { account?: viem_Account | undefined }) {
  return client.account
}

function assertDescriptor(payload: {
  descriptor?: Channel.ChannelDescriptor | undefined
}): asserts payload is { descriptor: Channel.ChannelDescriptor } {
  if (!payload.descriptor)
    throw new VerificationFailedError({
      reason: 'descriptor required for precompile session action',
    })
}

function assertSameDescriptor(a: Channel.ChannelDescriptor, b: Channel.ChannelDescriptor) {
  if (
    !isAddressEqual(a.payer, b.payer) ||
    !isAddressEqual(a.payee, b.payee) ||
    !isAddressEqual(a.operator, b.operator) ||
    !isAddressEqual(a.token, b.token) ||
    !isAddressEqual(a.authorizedSigner, b.authorizedSigner) ||
    a.salt.toLowerCase() !== b.salt.toLowerCase() ||
    a.expiringNonceHash.toLowerCase() !== b.expiringNonceHash.toLowerCase()
  )
    throw new VerificationFailedError({
      reason: 'credential descriptor does not match stored channel',
    })
}

/**
 * Validate a TIP20EscrowChannel descriptor against the credential channel ID and expected payment destination.
 */
function validateChannelDescriptor(
  descriptor: Channel.ChannelDescriptor,
  channelId: Hex,
  chainId: number,
  escrow: Address,
  recipient: Address,
  currency: Address,
): void {
  const computed = Channel.computeId({ ...descriptor, chainId, escrow })
  if (computed.toLowerCase() !== channelId.toLowerCase()) {
    throw new VerificationFailedError({ reason: 'channel descriptor does not match channelId' })
  }
  if (!isAddressEqual(descriptor.payee, recipient)) {
    throw new VerificationFailedError({
      reason: 'channel descriptor payee does not match server destination',
    })
  }
  if (!isAddressEqual(descriptor.token, currency)) {
    throw new VerificationFailedError({
      reason: 'channel descriptor token does not match server token',
    })
  }
}

/**
 * Validate on-chain channel state.
 */
function validateChannelState(state: Chain.ChannelState, amount?: bigint): void {
  if (state.deposit === 0n) {
    throw new ChannelNotFoundError({ reason: 'channel not funded on-chain' })
  }
  if (state.closeRequestedAt !== 0) {
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }
  if (amount !== undefined && state.deposit - state.settled < amount) {
    throw new InsufficientBalanceError({
      reason: 'channel available balance insufficient for requested amount',
    })
  }
}

/**
 * Shared logic for verifying an incremental voucher and updating channel state.
 * Used by handleVoucher after descriptor and cache resolution.
 */
async function verifyAndAcceptVoucher(parameters: {
  store: ChannelStore.ChannelStore
  minVoucherDelta: bigint
  challenge: Challenge.Challenge
  channel: ChannelStore.State
  voucher: SignedVoucher
  channelState: Chain.ChannelState
  methodDetails: SessionMethodDetails
}): Promise<SessionReceipt> {
  const { store, minVoucherDelta, challenge, channel, voucher, channelState, methodDetails } =
    parameters

  validateChannelState(channelState)
  if (voucher.cumulativeAmount <= channelState.settled)
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  if (voucher.cumulativeAmount > channelState.deposit)
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  if (voucher.cumulativeAmount < channel.highestVoucherAmount)
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount must be strictly greater than highest accepted voucher',
    })
  const valid = await Voucher.verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })

  // Idempotent replay: equal cumulative voucher is accepted without
  // advancing channel state or charging additional value.
  if (voucher.cumulativeAmount === channel.highestVoucherAmount)
    return createSessionReceipt({
      challengeId: challenge.id,
      channelId: voucher.channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
  const delta = voucher.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta)
    throw new DeltaTooSmallError({
      reason: `voucher delta ${delta} below minimum ${minVoucherDelta}`,
    })
  const updated = await store.updateChannel(voucher.channelId, (current) =>
    (() => {
      if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
      if (current.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
      if (current.closeRequestedAt !== 0n)
        throw new ChannelClosedError({ reason: 'channel has a pending close request' })

      const nextDeposit =
        channelState.deposit > current.deposit ? channelState.deposit : current.deposit
      const nextSettled =
        channelState.settled > current.settledOnChain
          ? channelState.settled
          : current.settledOnChain
      if (voucher.cumulativeAmount > current.highestVoucherAmount) {
        return {
          ...current,
          deposit: nextDeposit,
          settledOnChain: nextSettled,
          highestVoucherAmount: voucher.cumulativeAmount,
          highestVoucher: voucher,
        }
      }
      return { ...current, deposit: nextDeposit, settledOnChain: nextSettled }
    })(),
  )
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId: voucher.channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
  })
}

/**
 * Handle 'open' action - verify voucher, create channel, and broadcast.
 */
async function handleOpen(parameters: {
  store: ChannelStore.ChannelStore
  client: Chain.TransactionClient
  challenge: Challenge.Challenge
  payload: SessionCredentialPayload & { action: 'open' }
  chainId: number
  escrow: Address
  feePayer?: viem_Account | undefined
  feePayerPolicy?: session.FeePayerPolicy | undefined
}): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  assertDescriptor(payload)
  if (
    payload.authorizedSigner !== undefined &&
    !isAddressEqual(payload.authorizedSigner, payload.descriptor.authorizedSigner)
  )
    throw new VerificationFailedError({
      reason: 'credential authorizedSigner does not match descriptor',
    })
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    challenge.request.recipient as Address,
    challenge.request.currency as Address,
  )

  const result = await Chain.broadcastOpenTransaction({
    challengeExpires: challenge.expires,
    chainId,
    client,
    escrowContract: escrow,
    expectedAuthorizedSigner: payload.descriptor.authorizedSigner,
    expectedChannelId: channelId,
    expectedCurrency: challenge.request.currency as Address,
    expectedOperator: payload.descriptor.operator,
    expectedPayee: challenge.request.recipient as Address,
    expectedExpiringNonceHash: payload.descriptor.expiringNonceHash,
    expectedPayer: payload.descriptor.payer,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
    async beforeBroadcast(prepared) {
      assertSameDescriptor(prepared.descriptor, payload.descriptor)
      if (cumulativeAmount > prepared.openDeposit)
        throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds open deposit' })
      const valid = await Voucher.verifyVoucher(
        escrow,
        chainId,
        { channelId, cumulativeAmount: cumulativeAmount, signature: payload.signature },
        authorizedSigner(prepared.descriptor),
      )
      if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
    },
  })
  const { descriptor, state } = result
  assertSameDescriptor(descriptor, payload.descriptor)
  const amount = challenge.request.amount ? BigInt(challenge.request.amount as string) : undefined
  validateChannelState(state, amount)

  const updated = await store.updateChannel(channelId, (current) => ({
    ...(current ?? {}),
    backend: 'precompile',
    channelId: channelId,
    chainId,
    escrowContract: escrow,
    closeRequestedAt:
      current && current.closeRequestedAt > BigInt(state.closeRequestedAt)
        ? current.closeRequestedAt
        : BigInt(state.closeRequestedAt),
    payer: descriptor.payer,
    payee: descriptor.payee,
    token: descriptor.token,
    authorizedSigner: authorizedSigner(descriptor),
    deposit: state.deposit,
    settledOnChain:
      current && current.settledOnChain > state.settled ? current.settledOnChain : state.settled,
    highestVoucherAmount:
      current?.highestVoucherAmount && current.highestVoucherAmount > cumulativeAmount
        ? current.highestVoucherAmount
        : cumulativeAmount,
    highestVoucher:
      current?.highestVoucherAmount && current.highestVoucherAmount > cumulativeAmount
        ? current.highestVoucher
        : {
            channelId: channelId,
            cumulativeAmount: cumulativeAmount,
            signature: payload.signature,
          },
    spent: current && current.spent > state.settled ? current.spent : state.settled,
    units: current?.units ?? 0,
    finalized: current?.finalized ?? false,
    createdAt: current?.createdAt ?? new Date().toISOString(),
    descriptor,
    operator: descriptor.operator,
    salt: descriptor.salt,
    expiringNonceHash: result.expiringNonceHash,
  }))
  if (!updated) throw new VerificationFailedError({ reason: 'failed to create channel' })
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
    txHash: result.txHash,
  })
}

/**
 * Handle 'topUp' action - broadcast topUp transaction and update channel deposit.
 *
 * Per spec Section 8.3.2, topUp payloads contain only the transaction and
 * additionalDeposit — no voucher. The client must send a separate 'voucher'
 * action to authorize spending the new funds.
 */
async function handleTopUp(parameters: {
  store: ChannelStore.ChannelStore
  client: Chain.TransactionClient
  challenge: Challenge.Challenge
  payload: SessionCredentialPayload & { action: 'topUp' }
  chainId: number
  escrow: Address
  feePayer?: viem_Account | undefined
  feePayerPolicy?: session.FeePayerPolicy | undefined
}): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const additionalDeposit = uint96(BigInt(payload.additionalDeposit))
  assertDescriptor(payload)
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  assertSameDescriptor(payload.descriptor, channel.descriptor)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    channel.payee,
    channel.token,
  )
  const result = await Chain.broadcastTopUpTransaction({
    additionalDeposit,
    challengeExpires: challenge.expires,
    chainId,
    client,
    descriptor: channel.descriptor,
    escrowContract: escrow,
    expectedChannelId: channelId,
    expectedCurrency: channel.token,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
  })
  const { newDeposit, state } = result
  validateChannelState(state)

  const updated = await store.updateChannel(channelId, (current) =>
    current
      ? {
          ...current,
          deposit: newDeposit > current.deposit ? newDeposit : current.deposit,
          settledOnChain:
            state.settled > current.settledOnChain ? state.settled : current.settledOnChain,
          closeRequestedAt:
            BigInt(state.closeRequestedAt) > current.closeRequestedAt
              ? BigInt(state.closeRequestedAt)
              : current.closeRequestedAt,
        }
      : current,
  )
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated?.highestVoucherAmount ?? channel.highestVoucherAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash: result.txHash,
  })
}

/**
 * Handle 'voucher' action - verify and accept a new voucher.
 */
async function handleVoucher(parameters: {
  store: ChannelStore.ChannelStore
  client: Chain.TransactionClient
  challenge: Challenge.Challenge
  payload: SessionCredentialPayload & { action: 'voucher' }
  chainId: number
  escrow: Address
  minVoucherDelta: bigint
  channelStateTtl: number
  lastOnChainVerified: Map<Hex, number>
}): Promise<SessionReceipt> {
  const {
    store,
    client,
    challenge,
    payload,
    chainId,
    escrow,
    minVoucherDelta,
    channelStateTtl,
    lastOnChainVerified,
  } = parameters
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const voucher = Voucher.parseVoucherFromPayload(
    channelId,
    payload.cumulativeAmount,
    payload.signature,
  )
  assertDescriptor(payload)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  assertSameDescriptor(payload.descriptor, channel.descriptor)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    channel.payee,
    channel.token,
  )
  const isStale = Date.now() - (lastOnChainVerified.get(channelId) ?? 0) > channelStateTtl
  const state = isStale ? await Chain.getChannelState(client, channelId, escrow) : undefined
  if (state) lastOnChainVerified.set(channelId, Date.now())
  const channelState = {
    deposit: state?.deposit ?? uint96(channel.deposit),
    settled: state?.settled ?? uint96(channel.settledOnChain),
    closeRequestedAt: state?.closeRequestedAt ?? Number(channel.closeRequestedAt),
  }
  if (channelState.closeRequestedAt !== 0) {
    // Persist closeRequestedAt so the cached path detects force-close
    // between re-queries.
    await store.updateChannel(channelId, (current) =>
      current
        ? {
            ...current,
            closeRequestedAt:
              BigInt(channelState.closeRequestedAt) > current.closeRequestedAt
                ? BigInt(channelState.closeRequestedAt)
                : current.closeRequestedAt,
          }
        : current,
    )
  }
  return verifyAndAcceptVoucher({
    store,
    minVoucherDelta,
    challenge,
    channel,
    voucher,
    channelState,
    methodDetails: { chainId, escrowContract: escrow },
  })
}

/**
 * Handle 'close' action - verify final voucher and close channel.
 */
async function handleClose(parameters: {
  store: ChannelStore.ChannelStore
  client: Chain.TransactionClient
  challenge: Challenge.Challenge
  payload: SessionCredentialPayload & { action: 'close' }
  chainId: number
  escrow: Address
  account?: viem_Account | undefined
  feePayer?: viem_Account | undefined
  feePayerPolicy?: session.FeePayerPolicy | undefined
  feeToken?: Address | undefined
}): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  assertDescriptor(payload)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  assertSameDescriptor(payload.descriptor, channel.descriptor)
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (state.closeRequestedAt !== 0)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  if (state.deposit === 0n && (cumulativeAmount !== 0n || channel.spent !== 0n))
    throw new ChannelClosedError({ reason: 'channel deposit is zero (settled)' })
  if (cumulativeAmount < channel.spent)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${channel.spent} (spent)`,
    })
  if (cumulativeAmount < state.settled)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${state.settled} (on-chain settled)`,
    })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount: cumulativeAmount, signature: payload.signature },
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  let captureAmount = uint96(channel.spent > state.settled ? channel.spent : state.settled)
  if (captureAmount > state.deposit)
    throw new AmountExceedsDepositError({ reason: 'close capture amount exceeds on-chain deposit' })
  const pendingCloseStartedAt = BigInt(Math.floor(Date.now() / 1000) || 1)
  const previousCloseRequestedAt = channel.closeRequestedAt
  let pendingCloseMarked = false
  await store.updateChannel(channelId, (current) => {
    if (!current) return null
    if (current.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
    if (current.closeRequestedAt !== 0n)
      throw new ChannelClosedError({ reason: 'channel has a pending close request' })
    if (cumulativeAmount < current.spent)
      throw new VerificationFailedError({
        reason: `close voucher amount must be >= ${current.spent} (spent)`,
      })
    const currentCaptureAmount = uint96(
      current.spent > state.settled ? current.spent : state.settled,
    )
    if (currentCaptureAmount > cumulativeAmount)
      throw new VerificationFailedError({
        reason: `close voucher amount must be >= ${currentCaptureAmount} (capture amount)`,
      })
    if (currentCaptureAmount > state.deposit)
      throw new AmountExceedsDepositError({
        reason: 'close capture amount exceeds on-chain deposit',
      })
    captureAmount = currentCaptureAmount
    pendingCloseMarked = true
    return { ...current, closeRequestedAt: pendingCloseStartedAt }
  })
  const account = parameters.account ?? getClientAccount(client)
  let txHash: Hex | undefined
  let receipt: Awaited<ReturnType<typeof Chain.waitForSuccessfulReceipt>>
  try {
    assertSettlementSender({
      operation: 'close',
      channelId,
      operator: channel.operator,
      payee: channel.payee,
      sender: account?.address,
    })
    txHash = await Chain.closeOnChain(
      client,
      channel.descriptor,
      cumulativeAmount,
      captureAmount,
      payload.signature,
      escrow,
      account
        ? {
            account,
            ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
            ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
            ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
            candidateFeeTokens: [channel.token],
          }
        : undefined,
    )
    receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
  } catch (error) {
    if (pendingCloseMarked) {
      await store.updateChannel(channelId, (current) =>
        current && current.closeRequestedAt === pendingCloseStartedAt
          ? { ...current, closeRequestedAt: previousCloseRequestedAt }
          : current,
      )
    }
    throw error
  }
  const closed = Chain.getChannelEvent(receipt, 'ChannelClosed', channelId)
  const settledToPayee = uint96(closed.args.settledToPayee as bigint)
  const refundedToPayer = uint96(closed.args.refundedToPayer as bigint)
  if (settledToPayee > captureAmount || settledToPayee + refundedToPayer > state.deposit)
    throw new VerificationFailedError({ reason: 'ChannelClosed amounts do not match state' })
  const updated = await store.updateChannel(channelId, (current) =>
    current
      ? {
          ...current,
          finalized: true,
          closeRequestedAt: 0n,
          deposit: 0n,
          settledOnChain:
            captureAmount > current.settledOnChain ? captureAmount : current.settledOnChain,
          ...(cumulativeAmount > current.highestVoucherAmount
            ? {
                highestVoucherAmount: cumulativeAmount,
                highestVoucher: {
                  channelId,
                  cumulativeAmount: cumulativeAmount,
                  signature: payload.signature,
                },
              }
            : {}),
        }
      : current,
  )
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: cumulativeAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash,
  })
}
