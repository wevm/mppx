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
import {
  encodeFunctionData,
  isAddress,
  zeroAddress,
  type Account,
  type Address,
  type Client,
} from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { Transaction } from 'viem/tempo'

import type { Challenge } from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
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

type TempoChannelCall = {
  to: Address
  data: Hex.Hex
}

type AccountWithAccessKey = Account & {
  accessKeyAddress?: unknown
}

/** Client-side cached channel metadata used for automatic voucher management. */
export type ChannelEntry = {
  /** TIP-1034 channel ID derived from descriptor, escrow, and chain ID. */
  channelId: Hex.Hex
  /** Highest cumulative amount this client has locally authorized. */
  cumulativeAmount: bigint
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

function voucherAuthorizedSigner(address: Address): Address | undefined {
  return address.toLowerCase() === zeroAddress ? undefined : address
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

/** Resolves the voucher signer address for a client account and optional override. */
export function resolveAuthorizedSigner(account: Account, override?: Address | undefined): Address {
  return override ?? readAccessKeyAddress(account) ?? account.address
}

async function prepareTempoChannelTransaction(
  client: Client,
  parameters: {
    account: Account
    calls: readonly TempoChannelCall[]
    feePayer?: boolean | undefined
    feeToken: Address
  },
) {
  const { account, calls, feePayer, feeToken } = parameters
  // viem's stable transaction request type does not yet expose Tempo's
  // `calls`, `feePayer`, and `feeToken` fields together. Keep the cast at
  // this boundary so session credential builders stay typed.
  return prepareTransactionRequest(client, {
    account,
    calls,
    ...(feePayer ? { feePayer: true } : {}),
    feeToken,
  } as never)
}

async function signPreparedTempoTransaction(client: Client, prepared: unknown): Promise<Hex.Hex> {
  return (await signTransaction(client, prepared as never)) as Hex.Hex
}

/** Resolves the escrow precompile from local override, challenge hints, or canonical default. */
export function resolveEscrow(
  challenge: {
    request: {
      methodDetails?: unknown
    }
  },
  escrowOverride?: Address | undefined,
): Address {
  const methodDetails = challenge.request.methodDetails
  const challengeEscrow = isObject(methodDetails)
    ? (readOptionalAddress(methodDetails.escrowContract) ??
      readOptionalAddress(methodDetails.escrow))
    : undefined
  return escrowOverride ?? challengeEscrow ?? tip20ChannelEscrow
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
    source: `did:pkh:eip155:${chainId}:${account.address}`,
  })
}

/** Case-insensitive EVM address equality. */
export function isSameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
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
  const signature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: amount },
    escrow,
    chainId,
    voucherAuthorizedSigner(descriptor.authorizedSigner),
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
  return {
    action: 'close',
    channelId: voucher.channelId,
    descriptor,
    cumulativeAmount: voucher.cumulativeAmount,
    signature: voucher.signature,
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
    authorizedSigner?: Address | undefined
    chainId: number
    deposit: bigint
    escrow?: Address | undefined
    feePayer?: boolean | undefined
    initialAmount: bigint
    operator?: Address | undefined
    payee: Address
    token: Address
  },
): Promise<OpenCredentialPayload> {
  const authorizedSigner = resolveAuthorizedSigner(account, parameters.authorizedSigner)
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const operator = parameters.operator ?? '0x0000000000000000000000000000000000000000'
  const salt = Hex.random(32)

  const deposit = uint96(parameters.deposit)
  const initialAmount = uint96(parameters.initialAmount)
  const openData = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [parameters.payee, operator, parameters.token, deposit, salt, authorizedSigner],
  })
  const prepared = await prepareTempoChannelTransaction(client, {
    account,
    calls: [{ to: escrow, data: openData }],
    feePayer: parameters.feePayer,
    feeToken: parameters.token,
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
    voucherAuthorizedSigner(authorizedSigner),
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
    feeToken: descriptor.token,
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
