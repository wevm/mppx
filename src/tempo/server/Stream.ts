import type { Account, Address, Hex, Client as viem_Client } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'
import {
  AmountExceedsDepositError,
  BadRequestError,
  ChannelClosedError,
  ChannelConflictError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InsufficientBalanceError,
  InvalidSignatureError,
  VerificationFailedError,
} from '../../Errors.js'
import type { Challenge, Credential } from '../../index.js'
import type { LooseOmit } from '../../internal/types.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Client from '../../viem/Client.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'
import {
  broadcastOpenTransaction,
  broadcastTopUpTransaction,
  closeOnChain,
  getOnChainChannel,
  type OnChainChannel,
  settleOnChain,
} from '../stream/Chain.js'
import { createStreamReceipt } from '../stream/Receipt.js'
import type { ChannelState, ChannelStorage, SessionState } from '../stream/Storage.js'
import type { SignedVoucher, StreamCredentialPayload, StreamReceipt } from '../stream/Types.js'
import { parseVoucherFromPayload, verifyVoucher } from '../stream/Voucher.js'

/** Challenge methodDetails shape for stream intents. */
type StreamMethodDetails = {
  escrowContract: Address
  chainId: number
  channelId?: Hex | undefined
  minVoucherDelta?: string | undefined
  feePayer?: boolean | undefined
}

/**
 * Creates a stream payment server using the mpay Method.toServer() pattern.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const mpay = Mpay.create({
 *   methods: [
 *     tempo.stream({
 *       storage: myStorage,
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
export function stream<const defaults extends stream.Defaults>(
  parameters: stream.Parameters<defaults>,
) {
  const {
    amount,
    currency,
    decimals = 6,
    recipient,
    storage,
    suggestedDeposit,
    unitType,
    minVoucherDelta = 0n,
    feePayer,
  } = parameters

  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = defaults & { decimals: number; escrowContract: Address }
  return MethodIntent.toServer<typeof Intents.stream, Defaults>(Intents.stream, {
    defaults: {
      amount,
      currency,
      decimals,
      recipient,
      suggestedDeposit,
      unitType,
    } as Defaults,

    // TODO: dedupe `{charge,stream}.request`
    async request({ credential, request }) {
      // Extract chainId from request or default.
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
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

      const escrowContract =
        request.escrowContract ??
        defaults.escrowContract[chainId as keyof typeof defaults.escrowContract]

      // Extract feePayer.
      const feePayer = (() => {
        const account =
          typeof request.feePayer === 'object' ? request.feePayer : parameters.feePayer
        const requested = request.feePayer !== false && (account ?? parameters.feePayer)
        if (credential) return account
        if (requested) return true
        return undefined
      })()

      return { ...request, chainId, escrowContract, feePayer }
    },

    async verify({ credential }) {
      const { challenge, payload } = credential as Credential.Credential<StreamCredentialPayload>

      const methodDetails = challenge.request.methodDetails as StreamMethodDetails
      const client = await getClient({ chainId: methodDetails.chainId })

      const resolvedFeePayer = methodDetails.feePayer === true ? feePayer : undefined
      const effectiveMinVoucherDelta = methodDetails.minVoucherDelta
        ? BigInt(methodDetails.minVoucherDelta)
        : minVoucherDelta

      let streamReceipt: StreamReceipt

      switch (payload.action) {
        case 'open':
          streamReceipt = await handleOpen(
            storage,
            client,
            challenge,
            payload,
            methodDetails,
            resolvedFeePayer,
          )
          break

        case 'topUp':
          streamReceipt = await handleTopUp(
            storage,
            client,
            challenge,
            payload,
            methodDetails,
            resolvedFeePayer,
          )
          break

        case 'voucher':
          streamReceipt = await handleVoucher(
            storage,
            client,
            effectiveMinVoucherDelta,
            challenge,
            payload,
            methodDetails,
          )
          break

        case 'close':
          streamReceipt = await handleClose(storage, client, challenge, payload, methodDetails)
          break

        default:
          throw new BadRequestError({
            reason: `unknown action: ${(payload as { action: string }).action}`,
          })
      }

      return streamReceipt
    },
  })
}

export declare namespace stream {
  type Defaults = LooseOmit<MethodIntent.RequestDefaults<typeof Intents.stream>, 'feePayer'>

  type Parameters<defaults extends Defaults = {}> = {
    /** Storage backend for channel and session state. */
    storage: ChannelStorage
    /** Minimum voucher delta to accept (default: 0n). */
    minVoucherDelta?: bigint | undefined
    /** Optional fee payer account for covering open/topUp transaction fees. */
    feePayer?: Account | undefined
  } & Client.getResolver.Parameters &
    defaults
}

/**
 * One-shot settle: reads highest voucher from storage and submits on-chain.
 */
export async function settle(
  storage: ChannelStorage,
  client: viem_Client,
  escrowContract: Address,
  channelId: Hex,
): Promise<Hex> {
  const channel = await storage.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!channel.highestVoucher) throw new VerificationFailedError({ reason: 'no voucher to settle' })

  const settledAmount = channel.highestVoucher.cumulativeAmount
  const txHash = await settleOnChain(client, escrowContract, channel.highestVoucher)

  await storage.updateChannel(channelId, (current) => {
    if (!current) return null
    const nextSettled =
      settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
    return { ...current, settledOnChain: nextSettled }
  })

  return txHash
}

/**
 * Charge against an active session's balance.
 */
export async function charge(
  storage: ChannelStorage,
  challengeId: string,
  amount: bigint,
): Promise<SessionState> {
  const session = await storage.updateSession(challengeId, (current) => {
    if (!current) return null
    const available = current.acceptedCumulative - current.spent
    if (available < amount) {
      throw new InsufficientBalanceError({
        reason: `requested ${amount}, available ${available}`,
      })
    }
    return { ...current, spent: current.spent + amount, units: current.units + 1 }
  })

  if (!session) throw new ChannelClosedError({ reason: 'session not found' })
  return session
}

/**
 * Atomically upsert a session with a new acceptedCumulative.
 *
 * Safe under concurrent requests: cumulative semantics mean the highest
 * acceptedCumulative always wins, and updateChannel's atomic callback
 * ensures highestVoucherAmount is monotonically increasing.
 */
function acceptVoucher(
  storage: ChannelStorage,
  challengeId: string,
  channelId: Hex,
  acceptedCumulative: bigint,
): Promise<SessionState | null> {
  return storage.updateSession(challengeId, (existing) => {
    const base: SessionState = existing ?? {
      challengeId,
      channelId,
      acceptedCumulative: 0n,
      spent: 0n,
      units: 0,
      createdAt: new Date(),
    }
    const nextAccepted =
      acceptedCumulative > base.acceptedCumulative ? acceptedCumulative : base.acceptedCumulative
    return { ...base, acceptedCumulative: nextAccepted }
  })
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
 * Shared logic for verifying an incremental voucher, updating channel state,
 * and creating a session. Used by both handleTopUp and handleVoucher.
 */
async function verifyAndAcceptVoucher(parameters: {
  storage: ChannelStorage
  minVoucherDelta: bigint
  challenge: Challenge.Challenge
  channel: ChannelState
  channelId: Hex
  voucher: SignedVoucher
  onChain: OnChainChannel
  methodDetails: StreamMethodDetails
}): Promise<StreamReceipt> {
  const {
    storage,
    minVoucherDelta,
    challenge,
    channel,
    channelId,
    voucher,
    onChain,
    methodDetails,
  } = parameters

  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }

  if (voucher.cumulativeAmount < onChain.settled) {
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  }

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  }

  if (voucher.cumulativeAmount <= channel.highestVoucherAmount) {
    const session = await acceptVoucher(
      storage,
      challenge.id,
      channelId,
      channel.highestVoucherAmount,
    )
    if (!session) throw new VerificationFailedError({ reason: 'failed to create session' })
    return createStreamReceipt({
      challengeId: challenge.id,
      channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: session.spent,
      units: session.units,
    })
  }

  const delta = voucher.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta) {
    throw new DeltaTooSmallError({
      reason: `voucher delta ${delta} below minimum ${minVoucherDelta}`,
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

  await storage.updateChannel(channelId, (current) => {
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

  const session = await acceptVoucher(storage, challenge.id, channelId, voucher.cumulativeAmount)
  if (!session) throw new VerificationFailedError({ reason: 'failed to create session' })

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: session.spent,
    units: session.units,
  })
}

/**
 * Handle 'open' action - broadcast open transaction, verify voucher, and create channel.
 */
async function handleOpen(
  storage: ChannelStorage,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'open' },
  methodDetails: StreamMethodDetails,
  feePayer: Account | undefined,
): Promise<StreamReceipt> {
  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  const recipient = challenge.request.recipient as Address
  const currency = challenge.request.currency as Address
  const amount = challenge.request.amount ? BigInt(challenge.request.amount as string) : undefined

  const { onChain } = await broadcastOpenTransaction({
    client,
    serializedTransaction: payload.transaction,
    escrowContract: methodDetails.escrowContract,
    channelId: payload.channelId,
    recipient,
    currency,
    feePayer,
  })

  validateOnChainChannel(onChain, recipient, currency, amount)

  const authorizedSigner =
    onChain.authorizedSigner === '0x0000000000000000000000000000000000000000'
      ? onChain.payer
      : onChain.authorizedSigner

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  }

  if (voucher.cumulativeAmount < onChain.settled) {
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

  const session = await acceptVoucher(
    storage,
    challenge.id,
    payload.channelId,
    voucher.cumulativeAmount,
  )
  if (!session) throw new VerificationFailedError({ reason: 'failed to create session' })

  const existingChannel = await storage.getChannel(payload.channelId)
  let staleSessionId: string | undefined
  if (existingChannel?.activeSessionId) {
    const activeSession = await storage.getSession(existingChannel.activeSessionId)
    if (!activeSession) staleSessionId = existingChannel.activeSessionId
  }

  try {
    await storage.updateChannel(payload.channelId, (existing) => {
      if (existing) {
        if (
          existing.activeSessionId &&
          existing.activeSessionId !== challenge.id &&
          existing.activeSessionId !== staleSessionId
        ) {
          throw new ChannelConflictError({ reason: 'another stream is active on this channel' })
        }

        if (voucher.cumulativeAmount < existing.settledOnChain) {
          throw new VerificationFailedError({
            reason: 'voucher amount is below settled on-chain amount',
          })
        }

        if (voucher.cumulativeAmount > existing.highestVoucherAmount) {
          return {
            ...existing,
            deposit: onChain.deposit,
            highestVoucherAmount: voucher.cumulativeAmount,
            highestVoucher: voucher,
            authorizedSigner,
            activeSessionId: challenge.id,
          }
        }
        return {
          ...existing,
          deposit: onChain.deposit,
          authorizedSigner,
          activeSessionId: challenge.id,
        }
      }
      return {
        channelId: payload.channelId,
        payer: onChain.payer,
        payee: onChain.payee,
        token: onChain.token,
        authorizedSigner,
        deposit: onChain.deposit,
        settledOnChain: 0n,
        highestVoucherAmount: voucher.cumulativeAmount,
        highestVoucher: voucher,
        activeSessionId: challenge.id,
        finalized: false,
        createdAt: new Date(),
      }
    })
  } catch (e) {
    // Clean up the pre-created session on conflict/failure
    await storage.updateSession(challenge.id, () => null)
    throw e
  }

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: session.spent,
    units: session.units,
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
  storage: ChannelStorage,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'topUp' },
  methodDetails: StreamMethodDetails,
  feePayer: Account | undefined,
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }

  const declaredDeposit = BigInt(payload.additionalDeposit)

  const { newDeposit: onChainDeposit } = await broadcastTopUpTransaction({
    client,
    serializedTransaction: payload.transaction,
    escrowContract: methodDetails.escrowContract,
    channelId: payload.channelId,
    declaredDeposit,
    previousDeposit: channel.deposit,
    feePayer,
  })

  await storage.updateChannel(payload.channelId, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
    return { ...current, deposit: onChainDeposit }
  })

  const session = await storage.getSession(challenge.id)

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: session?.acceptedCumulative ?? channel.highestVoucherAmount,
    spent: session?.spent ?? 0n,
    units: session?.units ?? 0,
  })
}

/**
 * Handle 'voucher' action - verify and accept a new voucher.
 */
async function handleVoucher(
  storage: ChannelStorage,
  client: viem_Client,
  minVoucherDelta: bigint,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'voucher' },
  methodDetails: StreamMethodDetails,
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
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

  const onChain = await getOnChainChannel(client, methodDetails.escrowContract, payload.channelId)

  return verifyAndAcceptVoucher({
    storage,
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
  storage: ChannelStorage,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'close' },
  methodDetails: StreamMethodDetails,
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
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

  if (voucher.cumulativeAmount < channel.highestVoucherAmount) {
    throw new VerificationFailedError({
      reason: 'close voucher amount must be >= highest accepted voucher',
    })
  }

  const onChain = await getOnChainChannel(client, methodDetails.escrowContract, payload.channelId)

  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }

  if (voucher.cumulativeAmount < onChain.settled) {
    throw new VerificationFailedError({
      reason: 'close voucher cumulativeAmount is below on-chain settled amount',
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

  const session = await storage.getSession(challenge.id)

  let txHash: Hex | undefined
  if (client.account) {
    txHash = await closeOnChain(client, methodDetails.escrowContract, voucher)
  }

  await storage.updateChannel(payload.channelId, (current) => {
    if (!current) return null
    return {
      ...current,
      deposit: onChain.deposit,
      highestVoucherAmount: voucher.cumulativeAmount,
      highestVoucher: voucher,
      activeSessionId: undefined,
      finalized: true,
    }
  })
  await storage.updateSession(challenge.id, () => null)

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: session?.spent ?? 0n,
    units: session?.units ?? 0,
    ...(txHash !== undefined && { txHash }),
  })
}
