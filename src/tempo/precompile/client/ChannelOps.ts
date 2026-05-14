import { Hex } from 'ox'
import { encodeFunctionData, zeroAddress, type Account, type Address, type Client } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'

import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import type { SessionCredentialPayload, Uint96 } from '../Types.js'
import * as Voucher from '../Voucher.js'

export type OpenResult = {
  channelId: Hex.Hex
  descriptor: Channel.ChannelDescriptor
  transaction: Hex.Hex
  voucherSignature: Hex.Hex
}

export type TopUpResult = {
  channelId: Hex.Hex
  descriptor: Channel.ChannelDescriptor
  transaction: Hex.Hex
}

function voucherAuthorizedSigner(address: Address): Address | undefined {
  return address.toLowerCase() === zeroAddress ? undefined : address
}

function defaultAuthorizedSigner(account: Account): Address {
  return (account as unknown as { accessKeyAddress?: Address }).accessKeyAddress ?? account.address
}

/**
 * Prepares and signs a one-call TIP-1034 channel-open transaction, computes the
 * transaction-bound `expiringNonceHash` via viem, and signs the initial voucher.
 */
export async function createOpen(
  client: Client,
  account: Account,
  parameters: {
    authorizedSigner?: Address | undefined
    chainId: number
    deposit: Uint96
    escrow?: Address | undefined
    feePayer?: boolean | undefined
    initialAmount: Uint96
    operator?: Address | undefined
    payee: Address
    token: Address
  },
): Promise<OpenResult> {
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const authorizedSigner = parameters.authorizedSigner ?? defaultAuthorizedSigner(account)
  const operator = parameters.operator ?? '0x0000000000000000000000000000000000000000'
  const salt = Hex.random(32)

  const openData = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [parameters.payee, operator, parameters.token, parameters.deposit, salt, authorizedSigner],
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to: escrow, data: openData }],
    ...(parameters.feePayer ? { feePayer: true } : {}),
    feeToken: parameters.token,
  } as never)

  const expiringNonceHash = Channel.computeExpiringNonceHash(
    prepared as Channel.ExpiringNonceTransaction,
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
  const voucherSignature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: parameters.initialAmount },
    escrow,
    parameters.chainId,
    voucherAuthorizedSigner(authorizedSigner),
  )
  const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

  return { channelId, descriptor, transaction, voucherSignature }
}

/** Creates a TIP-1034 open credential payload from a signed open transaction. */
export function createOpenCredential(
  result: OpenResult,
  initialAmount: Uint96,
): Extract<SessionCredentialPayload, { action: 'open' }> {
  return {
    action: 'open',
    type: 'transaction',
    channelId: result.channelId,
    transaction: result.transaction,
    signature: result.voucherSignature,
    descriptor: result.descriptor,
    cumulativeAmount: initialAmount.toString(),
    authorizedSigner: result.descriptor.authorizedSigner,
  }
}

/** Signs and creates a TIP-1034 voucher credential payload for an existing channel. */
export async function createVoucherCredential(
  client: Client,
  account: Account,
  parameters: {
    chainId: number
    cumulativeAmount: Uint96
    descriptor: Channel.ChannelDescriptor
    escrow?: Address | undefined
  },
): Promise<Extract<SessionCredentialPayload, { action: 'voucher' }>> {
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const channelId = Channel.computeId({
    ...parameters.descriptor,
    chainId: parameters.chainId,
    escrow,
  })
  const signature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: parameters.cumulativeAmount },
    escrow,
    parameters.chainId,
    voucherAuthorizedSigner(parameters.descriptor.authorizedSigner),
  )

  return {
    action: 'voucher',
    channelId,
    descriptor: parameters.descriptor,
    cumulativeAmount: parameters.cumulativeAmount.toString(),
    signature,
  }
}

/** Prepares and signs a one-call TIP-1034 top-up transaction for an existing channel. */
export async function createTopUp(
  client: Client,
  account: Account,
  parameters: {
    additionalDeposit: Uint96
    chainId: number
    descriptor: Channel.ChannelDescriptor
    escrow?: Address | undefined
    feePayer?: boolean | undefined
  },
): Promise<TopUpResult> {
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const channelId = Channel.computeId({
    ...parameters.descriptor,
    chainId: parameters.chainId,
    escrow,
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [
      {
        to: escrow,
        data: encodeFunctionData({
          abi: escrowAbi,
          functionName: 'topUp',
          args: [parameters.descriptor, parameters.additionalDeposit],
        }),
      },
    ],
    ...(parameters.feePayer ? { feePayer: true } : {}),
    feeToken: parameters.descriptor.token,
  } as never)
  const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

  return { channelId, descriptor: parameters.descriptor, transaction }
}

/** Creates a TIP-1034 top-up credential payload from a signed top-up transaction. */
export function createTopUpCredential(
  result: TopUpResult,
  additionalDeposit: Uint96,
): Extract<SessionCredentialPayload, { action: 'topUp' }> {
  return {
    action: 'topUp',
    type: 'transaction',
    channelId: result.channelId,
    transaction: result.transaction,
    descriptor: result.descriptor,
    additionalDeposit: additionalDeposit.toString(),
  }
}

/** Signs and creates a TIP-1034 close credential payload for an existing channel. */
export async function createCloseCredential(
  client: Client,
  account: Account,
  parameters: {
    chainId: number
    cumulativeAmount: Uint96
    descriptor: Channel.ChannelDescriptor
    escrow?: Address | undefined
  },
): Promise<Extract<SessionCredentialPayload, { action: 'close' }>> {
  const voucher = await createVoucherCredential(client, account, parameters)
  return {
    action: 'close',
    channelId: voucher.channelId,
    descriptor: voucher.descriptor,
    cumulativeAmount: voucher.cumulativeAmount,
    signature: voucher.signature,
  }
}
