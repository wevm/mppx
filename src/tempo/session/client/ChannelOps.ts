/**
 * Shared client-side TIP-1034 channel operations.
 *
 * Provides the low-level helpers that both `tempo.session()` and
 * `tempo.session.manager()` rely on: channel ID computation,
 * transaction-bound descriptor construction, on-chain open/top-up payload
 * construction, voucher/close payload serialization, and transaction signing.
 *
 * @see https://tips.sh/1034-1
 */
import { Hex } from 'ox'
import { AccountConfig } from 'ox/tempo'
import {
  decodeErrorResult,
  encodeFunctionData,
  isAddress,
  type Account,
  type Address,
  type Client,
} from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { Actions, Transaction } from 'viem/tempo'

import type { Challenge } from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as Errors from '../../../Errors.js'
import * as Simulation from '../../internal/simulation.js'
import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import type {
  CloseCredentialPayload,
  OpenCredentialPayload,
  SessionCredentialPayload,
  TopUpCredentialPayload,
  VoucherCredentialPayload,
} from '../precompile/Protocol.js'
import { uint96 } from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'

export type TempoChannelCall = {
  to: Address
  data: Hex.Hex
}

type AccountWithAccessKey = Account & {
  accessKeyAddress?: unknown
}

/** Client-side cached channel metadata used for automatic voucher management. */
export type ChannelEntry = {
  /** HTTP origin bound by a session manager; absent on legacy or standalone method entries. */
  origin?: string | undefined
  /** TIP-1034 channel ID derived from descriptor, escrow, and chain ID. */
  channelId: Hex.Hex
  /** Highest cumulative amount this client has locally authorized. */
  cumulativeAmount: bigint
  /** Blocks new deposits until an uncertain top-up has been reconciled against trusted chain state. */
  uncertainTopUp?: boolean | undefined
  /** Latest channel deposit known by the client. */
  deposit: bigint
  /** TIP-1034 descriptor required for vouchers, top-ups, and close credentials. */
  descriptor: Channel.ChannelDescriptor
  /** Escrow contract address used to derive `channelId`. */
  escrow: Address
  /** EVM chain ID used for channel ID and voucher domain separation. */
  chainId: number
  /** Whether the client considers the channel reusable for new vouchers. */
  opened: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readOptionalAddress(value: unknown): Address | undefined {
  return typeof value === 'string' && isAddress(value, { strict: false }) ? value : undefined
}

function readAccessKeyAddress(account: Account): Address | undefined {
  return readOptionalAddress((account as AccountWithAccessKey).accessKeyAddress)
}

/** Returns random past seconds to distinguish otherwise-identical expiring transactions. */
function randomValidAfter(): number {
  const now = BigInt(Math.floor(Date.now() / 1_000))
  const latest = now - 60n
  if (latest <= 0n) return 0
  return Number(BigInt(Hex.random(8)) % latest)
}

/**
 * Seconds from now of the default expiring-nonce `validBefore`, matching viem's Tempo default
 * and staying under the protocol's 300-second limit.
 */
const expiringNonceWindowSeconds = 270

/**
 * Bounds an open transaction's `validBefore` by a caller deadline in Unix seconds, keeping the
 * default window when it ends sooner. Throws when the deadline has already passed.
 */
function resolveOpenValidBefore(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined
  if (!Number.isSafeInteger(deadline)) throw new Error('validBefore must be whole Unix seconds.')
  const now = Math.floor(Date.now() / 1_000)
  if (deadline <= now) throw new Error('Channel open validBefore has already passed.')
  return Math.min(deadline, now + expiringNonceWindowSeconds)
}

/** Resolves the voucher authority address for a client account. */
export function resolveAuthorizedSigner(account: Account): Address {
  return readAccessKeyAddress(account) ?? account.address
}

/**
 * Returns whether a client account's vouchers are TIP-1166 configurable account (`0x05`)
 * signatures, which only servers that advertise `configurableVouchers` accept.
 */
export function isConfigurableSigner(account: Account): boolean {
  return resolveConfigurableSigner(account) !== undefined
}

/**
 * Returns the configurable account that signs a client account's vouchers: the account itself,
 * or the configurable account behind a configurable access key (TIP-1111), which signs vouchers
 * raw as the channel's authorized signer.
 */
function resolveConfigurableSigner(
  account: Account,
): (Account & { config?: AccountConfig.Config | undefined }) | undefined {
  const accessKeyAddress = readAccessKeyAddress(account)
  if (accessKeyAddress === undefined)
    return Voucher.isConfigurableAccount(account) ? account : undefined
  const delegate = (account as { delegate?: Account | undefined }).delegate
  if (
    delegate &&
    Voucher.isConfigurableAccount(delegate) &&
    delegate.address.toLowerCase() === accessKeyAddress.toLowerCase()
  )
    return delegate
  return undefined
}

/**
 * Resolves the default TIP-1034 open salt for a client account.
 *
 * From T15 (TIP-1166), the escrow requires the salt of a channel whose signer has a config
 * commitment to equal that commitment, and records it so vouchers are checked against it. A
 * configurable account signer therefore opens with its commitment: the one on chain, or, when it
 * is not registered yet, the one its version-zero config registers in the open transaction itself.
 * Every other account gets a random salt, with no RPC call.
 */
export async function resolveOpenSalt(client: Client, account: Account): Promise<Hex.Hex> {
  const signer = resolveConfigurableSigner(account)
  if (!signer) return Hex.random(32)
  const { config } = signer
  const onChain = await Actions.accounts.getConfigCommitment(client, { account: signer.address })
  const local = config ? AccountConfig.getCommitment(config) : undefined
  if (BigInt(onChain) !== 0n) {
    if (local && local.toLowerCase() !== onChain.toLowerCase())
      throw new Error(
        `Configurable account ${signer.address} holds a config whose commitment ${local} does not match its on-chain commitment ${onChain}. Use the account's current config.`,
      )
    return onChain
  }
  if (!local || BigInt(config!.version ?? 0n) !== 0n)
    throw new Error(
      `Configurable account ${signer.address} is not registered, so it needs its version-zero config to open a channel.`,
    )
  return local
}

/**
 * Maps a top-up simulation that reverted with TIP-1166 `SignerConfigChanged` or
 * `RootKeyRetired` for the channel signer to {@link Errors.SignerConfigChangedError}.
 */
function toSignerConfigChangedError(
  error: unknown,
  parameters: { channelId: Hex.Hex; signer: Address },
): Errors.SignerConfigChangedError | undefined {
  const data = Simulation.getRevertData(error)
  if (!data) return undefined
  try {
    const decoded = decodeErrorResult({ abi: escrowAbi, data })
    if (decoded.errorName !== 'SignerConfigChanged' && decoded.errorName !== 'RootKeyRetired')
      return undefined
    const [signer] = decoded.args as readonly [Address]
    if (signer.toLowerCase() !== parameters.signer.toLowerCase()) return undefined
    return new Errors.SignerConfigChangedError({
      cause: error,
      channelId: parameters.channelId,
      reason: decoded.errorName,
      signer,
    })
  } catch {
    return undefined
  }
}

async function prepareTempoChannelTransaction(
  client: Client,
  parameters: {
    account: Account
    calls: readonly TempoChannelCall[]
    feePayer?: boolean | undefined
    feeToken: Address
    validAfter?: number | undefined
    validBefore?: number | undefined
  },
) {
  const { account, calls, feePayer, feeToken, validAfter, validBefore } = parameters
  // Session management transactions are independent and short-lived, so they
  // always use TIP-1009 expiring nonces. `feePayer` controls sponsorship only.
  // viem's stable transaction request type does not yet expose Tempo's
  // `calls`, `feePayer`, and `feeToken` fields together. Keep the cast at
  // this boundary so session credential builders stay typed.
  // Preparation estimates gas, which simulates the calls as the signing key, so a deposit the
  // key's spending limit or the account's balance cannot cover fails here, before signing.
  return Simulation.run({ account }, () =>
    prepareTransactionRequest(client, {
      account,
      calls,
      nonceKey: 'expiring',
      ...(feePayer ? { feePayer: true } : {}),
      feeToken,
      ...(validAfter !== undefined ? { validAfter } : {}),
      ...(validBefore !== undefined ? { validBefore } : {}),
    } as never),
  )
}

async function signPreparedTempoTransaction(client: Client, prepared: unknown): Promise<Hex.Hex> {
  return (await signTransaction(client, prepared as never)) as Hex.Hex
}

/** Resolves the server-advertised escrow against the client's trust policy. */
export function resolveEscrow(
  challenge: {
    request: {
      methodDetails?: unknown
    }
  },
  escrowOverride?: Address | undefined,
  allowCustomEscrow = false,
): Address {
  const methodDetails = challenge.request.methodDetails
  const challengeEscrow = isObject(methodDetails)
    ? (readOptionalAddress(methodDetails.escrowContract) ??
      readOptionalAddress(methodDetails.escrow))
    : undefined
  const expectedEscrow = escrowOverride ?? tip20ChannelEscrow
  if (
    challengeEscrow &&
    !isSameAddress(challengeEscrow, expectedEscrow) &&
    (!allowCustomEscrow || escrowOverride !== undefined)
  )
    throw new Error(
      `Tempo session escrow ${challengeEscrow} does not match client escrow ${expectedEscrow}.`,
    )
  if (challengeEscrow && !isSameAddress(challengeEscrow, expectedEscrow)) return challengeEscrow
  return expectedEscrow
}

/** Serializes a session credential with a DID source bound to the payer account. */
export function serializeCredential(
  challenge: Challenge,
  payload: SessionCredentialPayload,
  chainId: number,
  account: Account,
): string {
  return Credential.serialize({
    challenge,
    payload,
    source: `did:pkh:eip155:${chainId}:${payload.descriptor?.payer ?? account.address}`,
  })
}

/** Case-insensitive EVM address equality. */
export function isSameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Asserts that a configurable account signer can sign a voucher an existing channel settles
 * (TIP-1166). A channel whose signer had a config commitment at open carries it as its salt and
 * settles only `0x05` vouchers whose config hashes to it. A channel opened with no commitment (a
 * zero opening commitment) settles a `0x05` voucher only from the version-zero config that derives the
 * signer's address; otherwise it settles only primitive vouchers, which a configurable account
 * cannot sign. Primitive account signers keep signing primitive vouchers.
 */
export function assertCanSignVoucher(account: Account, descriptor: Channel.ChannelDescriptor) {
  const signer = resolveConfigurableSigner(account)
  if (!signer?.config) return
  const { config } = signer
  if (AccountConfig.getCommitment(config).toLowerCase() === descriptor.salt.toLowerCase()) return
  if (
    BigInt(config.version ?? 0n) === 0n &&
    AccountConfig.getAddress(config).toLowerCase() === signer.address.toLowerCase()
  )
    return
  throw new Error(
    `Configurable account ${signer.address} holds a config that does not match the channel's opening commitment (salt ${descriptor.salt}), so it cannot sign a voucher the channel settles. Sign with the config the channel opened with, or close the channel and open a new one.`,
  )
}

/**
 * Signs and creates a TIP-1034 voucher credential payload for an existing channel.
 *
 * @see https://tips.sh/1034-1#execution-semantics
 */
export async function createVoucherPayload(
  client: Client,
  account: Account,
  descriptor: Channel.ChannelDescriptor,
  cumulativeAmount: bigint,
  chainId: number,
  escrow: Address = tip20ChannelEscrow,
): Promise<VoucherCredentialPayload> {
  const channelId = Channel.computeId({
    ...descriptor,
    chainId,
    escrow,
  })
  const amount = uint96(cumulativeAmount)
  assertCanSignVoucher(account, descriptor)
  const signature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: amount },
    escrow,
    chainId,
  )

  return {
    action: 'voucher',
    channelId,
    descriptor,
    cumulativeAmount: amount.toString(),
    signature,
  }
}

/**
 * Signs and creates a TIP-1034 close credential payload for an existing channel.
 *
 * @see https://tips.sh/1034-1#execution-semantics
 */
export async function createClosePayload(
  client: Client,
  account: Account,
  descriptor: Channel.ChannelDescriptor,
  cumulativeAmount: bigint,
  chainId: number,
  escrow: Address = tip20ChannelEscrow,
): Promise<CloseCredentialPayload> {
  const voucher = await createVoucherPayload(
    client,
    account,
    descriptor,
    cumulativeAmount,
    chainId,
    escrow,
  )
  const closeSignature = await Voucher.signCloseAuthorization(
    client,
    account,
    {
      channelId: voucher.channelId,
      cumulativeAmount: uint96(BigInt(voucher.cumulativeAmount)),
    },
    escrow,
    chainId,
  )
  return {
    action: 'close',
    channelId: voucher.channelId,
    descriptor,
    cumulativeAmount: voucher.cumulativeAmount,
    signature: voucher.signature,
    closeSignature,
  }
}

/**
 * Prepares, signs, and creates a TIP-1034 open credential payload.
 *
 * The channel descriptor uses the signed transaction's expiring nonce hash
 * because TIP-1034 binds each opened channel to that transaction context.
 *
 * @see https://tips.sh/1034-1#channel-identity-and-packed-state
 */
export async function createOpenPayload(
  client: Client,
  account: Account,
  parameters: {
    chainId: number
    deposit: bigint
    escrow?: Address | undefined
    feePayer?: boolean | undefined
    feeToken?: Address | undefined
    initialAmount: bigint
    operator?: Address | undefined
    payee: Address
    /** Calls executed atomically before the channel is opened. */
    prefixCalls?: readonly TempoChannelCall[] | undefined
    /**
     * Channel salt. Defaults to the signer's TIP-1166 config commitment for a configurable
     * account, else a random value. See {@link resolveOpenSalt}.
     */
    salt?: Hex.Hex | undefined
    token: Address
    /**
     * Latest time, in Unix seconds, at which the open transaction may land. Defaults to the
     * expiring-nonce window; a later value keeps the default.
     */
    validBefore?: number | undefined
  },
): Promise<OpenCredentialPayload> {
  const validBefore = resolveOpenValidBefore(parameters.validBefore)
  const authorizedSigner = resolveAuthorizedSigner(account)
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const operator = parameters.operator ?? '0x0000000000000000000000000000000000000000'
  const salt = parameters.salt ?? (await resolveOpenSalt(client, account))

  const deposit = uint96(parameters.deposit)
  const initialAmount = uint96(parameters.initialAmount)
  const openData = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [parameters.payee, operator, parameters.token, deposit, salt, authorizedSigner],
  })
  const prepared = await prepareTempoChannelTransaction(client, {
    account,
    calls: [...(parameters.prefixCalls ?? []), { to: escrow, data: openData }],
    feePayer: parameters.feePayer,
    feeToken: parameters.feeToken ?? parameters.token,
    // A configurable signer's salt is its stable config commitment, so the open needs its own
    // entropy to get a distinct expiring nonce hash and channel ID.
    validAfter: randomValidAfter(),
    validBefore,
  })
  const transaction = await signPreparedTempoTransaction(client, prepared)
  const signed = Transaction.deserialize(transaction as Transaction.TransactionSerializedTempo)

  const expiringNonceHash = Channel.computeExpiringNonceHash(
    Channel.transactionForExpiringNonceHash({
      ...(parameters.feePayer ? { feePayer: true } : {}),
      transaction: signed,
    }),
    { sender: account.address },
  )
  const descriptor = {
    authorizedSigner,
    expiringNonceHash,
    operator,
    payee: parameters.payee,
    payer: account.address,
    salt,
    token: parameters.token,
  } satisfies Channel.ChannelDescriptor
  const channelId = Channel.computeId({
    ...descriptor,
    chainId: parameters.chainId,
    escrow,
  })
  const signature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: initialAmount },
    escrow,
    parameters.chainId,
  )
  return {
    action: 'open',
    type: 'transaction',
    channelId,
    transaction,
    signature,
    descriptor,
    cumulativeAmount: initialAmount.toString(),
    authorizedSigner: descriptor.authorizedSigner,
  }
}

/**
 * Prepares, signs, and creates a TIP-1034 top-up credential payload.
 *
 * @see https://tips.sh/1034-1#execution-semantics
 */
export async function createTopUpPayload(
  client: Client,
  account: Account,
  descriptor: Channel.ChannelDescriptor,
  additionalDeposit: bigint,
  chainId: number,
  feePayer?: boolean | undefined,
  escrow: Address = tip20ChannelEscrow,
  prefixCalls: readonly TempoChannelCall[] = [],
  feeToken: Address = descriptor.token,
): Promise<TopUpCredentialPayload> {
  const channelId = Channel.computeId({
    ...descriptor,
    chainId,
    escrow,
  })
  const deposit = uint96(additionalDeposit)
  const prepared = await prepareTempoChannelTransaction(client, {
    account,
    calls: [
      ...prefixCalls,
      {
        to: escrow,
        data: encodeFunctionData({
          abi: escrowAbi,
          functionName: 'topUp',
          args: [descriptor, deposit],
        }),
      },
    ],
    feePayer,
    feeToken,
    validAfter: randomValidAfter(),
  }).catch((error: unknown) => {
    throw (
      toSignerConfigChangedError(error, {
        channelId,
        signer: Channel.resolveAuthorizedSigner(descriptor),
      }) ?? error
    )
  })
  const transaction = await signPreparedTempoTransaction(client, prepared)

  return {
    action: 'topUp',
    type: 'transaction',
    channelId,
    transaction,
    descriptor,
    additionalDeposit: deposit.toString(),
  }
}
