import { Hex as OxHex } from 'ox'
import type { Address, Call, Client, Hex } from 'viem'
import { encodeFunctionData } from 'viem'
import type { Account } from 'viem/accounts'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { Abis } from 'viem/tempo'

import type * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import { getAccountSignerAddress } from './internal/account.js'
import * as defaults from './internal/defaults.js'
import * as Methods from './Methods.js'
import { escrowAbi } from './session/Chain.js'
import * as Channel from './session/Channel.js'
import type { SessionCredentialPayload } from './session/Types.js'
import { signVoucher } from './session/Voucher.js'

export * as Chain from './session/Chain.js'
export * as Channel from './session/Channel.js'
export * as ChannelStore from './session/ChannelStore.js'
export * as Receipt from './session/Receipt.js'
export * as Sse from './session/Sse.js'
export * as Types from './session/Types.js'
export * as Voucher from './session/Voucher.js'
export * as Ws from './session/Ws.js'

export type SessionChallenge = Challenge.Challenge<
  ReturnType<typeof Methods.session.schema.request.parse>,
  'session',
  'tempo'
>

export type ChannelEntry = {
  authorizedSigner?: Address | undefined
  channelId: Hex
  salt: Hex
  cumulativeAmount: bigint
  escrowContract: Address
  chainId: number
  opened: boolean
}

export type { Call }

function resolveChainId(client: Client, challenge: SessionChallenge): number {
  const chainId = challenge.request.methodDetails?.chainId ?? client.chain?.id
  if (chainId === undefined)
    throw new Error('No `chainId` provided. Pass a chain ID in the challenge or client.')
  return chainId
}

function resolveEscrow(challenge: SessionChallenge, chainId: number, override?: Address): Address {
  const escrow =
    override ??
    (challenge.request.methodDetails?.escrowContract as Address | undefined) ??
    defaults.escrowContract[chainId as keyof typeof defaults.escrowContract]
  if (!escrow)
    throw new Error(
      'No `escrowContract` available. Provide it in parameters or ensure the server challenge includes it.',
    )
  return escrow
}

function source(chainId: number, signer: Account): string {
  return `did:pkh:eip155:${chainId}:${signer.address}`
}

function serializeCredential(parameters: {
  challenge: SessionChallenge
  payload: SessionCredentialPayload
  chainId: number
  signer: Account
}): string {
  return Credential.serialize({
    challenge: parameters.challenge,
    payload: parameters.payload,
    source: source(parameters.chainId, parameters.signer),
  })
}

async function signSessionTransaction(
  client: Client,
  parameters: {
    calls: readonly Call[]
    feePayer?: boolean | undefined
    feeToken?: Address | undefined
    signer: Account
  },
): Promise<Hex> {
  const { calls, feePayer, feeToken, signer } = parameters
  const validBefore = Math.floor(Date.now() / 1_000) + 25
  const prepared = await prepareTransactionRequest(client, {
    account: signer,
    calls,
    ...(feeToken ? { feeToken } : {}),
    ...(feePayer ? { nonceKey: 'expiring', validBefore } : {}),
  } as never)
  // Estimate before enabling fee-payer mode so Tempo includes sender
  // signature and access-key verification costs in the gas budget.
  prepared.gas = (prepared.gas ?? 0n) + 5_000n
  if (feePayer) (prepared as Record<string, unknown>).feePayer = true
  return (await signTransaction(client, prepared as never)) as Hex
}

async function fillOpen(
  client: Client,
  parameters: open.fill.Parameters,
): Promise<open.fill.Filled> {
  const { authorizedSigner, challenge, deposit, escrowContract: escrowOverride, payer } = parameters
  const chainId = resolveChainId(client, challenge)
  const escrowContract = resolveEscrow(challenge, chainId, escrowOverride)
  const payee = challenge.request.recipient as Address
  const currency = challenge.request.currency as Address
  const initialAmount = BigInt(challenge.request.amount)
  const feePayer = Boolean(challenge.request.methodDetails?.feePayer)
  const salt = OxHex.random(32) as Hex
  const channelId = Channel.computeId({
    authorizedSigner,
    chainId,
    escrowContract,
    payee,
    payer,
    salt,
    token: currency,
  })
  const calls = [
    {
      to: currency,
      data: encodeFunctionData({
        abi: Abis.tip20,
        functionName: 'approve',
        args: [escrowContract, deposit],
      }),
    },
    {
      to: escrowContract,
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: 'open',
        args: [payee, currency, deposit, salt, authorizedSigner],
      }),
    },
  ] satisfies readonly Call[]

  return {
    authorizedSigner,
    calls,
    chainId,
    challenge,
    channelId,
    currency,
    deposit,
    escrowContract,
    feePayer,
    initialAmount,
    kind: 'open',
    payee,
    payer,
    salt,
  }
}

async function createOpenCredential(
  client: Client,
  parameters: open.createCredential.Parameters,
): Promise<string> {
  const { filled, signer, voucherSigner } = parameters
  const resolvedVoucherSigner = voucherSigner ?? signer
  const authorizedSigner = getAccountSignerAddress(resolvedVoucherSigner)
  if (signer.address.toLowerCase() !== filled.payer.toLowerCase())
    throw new Error('signer does not match filled payer.')
  if (authorizedSigner.toLowerCase() !== filled.authorizedSigner.toLowerCase())
    throw new Error('voucherSigner does not match filled authorizedSigner.')

  const transaction = await signSessionTransaction(client, {
    calls: filled.calls,
    feePayer: filled.feePayer,
    feeToken: filled.currency,
    signer,
  })
  const signature = await signVoucher(
    client,
    signer,
    { channelId: filled.channelId, cumulativeAmount: filled.initialAmount },
    filled.escrowContract,
    filled.chainId,
    resolvedVoucherSigner,
  )

  return serializeCredential({
    challenge: filled.challenge,
    chainId: filled.chainId,
    signer,
    payload: {
      action: 'open',
      type: 'transaction',
      authorizedSigner: filled.authorizedSigner,
      channelId: filled.channelId,
      cumulativeAmount: filled.initialAmount.toString(),
      signature,
      transaction,
    },
  })
}

async function fillTopUp(
  client: Client,
  parameters: topUp.fill.Parameters,
): Promise<topUp.fill.Filled> {
  const { additionalDeposit, challenge, channelId, escrowContract: escrowOverride } = parameters
  const chainId = resolveChainId(client, challenge)
  const escrowContract = resolveEscrow(challenge, chainId, escrowOverride)
  const currency = challenge.request.currency as Address
  const feePayer = Boolean(challenge.request.methodDetails?.feePayer)
  const calls = [
    {
      to: currency,
      data: encodeFunctionData({
        abi: Abis.tip20,
        functionName: 'approve',
        args: [escrowContract, additionalDeposit],
      }),
    },
    {
      to: escrowContract,
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: 'topUp',
        args: [channelId, additionalDeposit],
      }),
    },
  ] satisfies readonly Call[]

  return {
    additionalDeposit,
    calls,
    chainId,
    challenge,
    channelId,
    currency,
    escrowContract,
    feePayer,
    kind: 'topUp',
  }
}

async function createTopUpCredential(
  client: Client,
  parameters: topUp.createCredential.Parameters,
): Promise<string> {
  const { filled, signer } = parameters
  const transaction = await signSessionTransaction(client, {
    calls: filled.calls,
    feePayer: filled.feePayer,
    feeToken: filled.feePayer ? filled.currency : undefined,
    signer,
  })

  return serializeCredential({
    challenge: filled.challenge,
    chainId: filled.chainId,
    signer,
    payload: {
      action: 'topUp',
      type: 'transaction',
      additionalDeposit: filled.additionalDeposit.toString(),
      channelId: filled.channelId,
      transaction,
    },
  })
}

async function createVoucherCredential(
  client: Client,
  parameters: voucher.createCredential.Parameters,
): Promise<string> {
  const {
    challenge,
    channelId,
    cumulativeAmount,
    escrowContract: escrowOverride,
    signer,
    voucherSigner,
  } = parameters
  const chainId = resolveChainId(client, challenge)
  const escrowContract = resolveEscrow(challenge, chainId, escrowOverride)
  const signature = await signVoucher(
    client,
    signer,
    { channelId, cumulativeAmount },
    escrowContract,
    chainId,
    voucherSigner ?? signer,
  )

  return serializeCredential({
    challenge,
    chainId,
    signer,
    payload: {
      action: 'voucher',
      channelId,
      cumulativeAmount: cumulativeAmount.toString(),
      signature,
    },
  })
}

async function createCloseCredential(
  client: Client,
  parameters: close.createCredential.Parameters,
): Promise<string> {
  const {
    challenge,
    channelId,
    cumulativeAmount,
    escrowContract: escrowOverride,
    signer,
    voucherSigner,
  } = parameters
  const chainId = resolveChainId(client, challenge)
  const escrowContract = resolveEscrow(challenge, chainId, escrowOverride)
  const signature = await signVoucher(
    client,
    signer,
    { channelId, cumulativeAmount },
    escrowContract,
    chainId,
    voucherSigner ?? signer,
  )

  return serializeCredential({
    challenge,
    chainId,
    signer,
    payload: {
      action: 'close',
      channelId,
      cumulativeAmount: cumulativeAmount.toString(),
      signature,
    },
  })
}

/** Stateless helpers for opening a Tempo session channel. */
export const open = {
  fill: fillOpen,
  createCredential: createOpenCredential,
}

export declare namespace open {
  namespace fill {
    type Filled = {
      authorizedSigner: Address
      calls: readonly Call[]
      chainId: number
      challenge: SessionChallenge
      channelId: Hex
      currency: Address
      deposit: bigint
      escrowContract: Address
      feePayer: boolean
      initialAmount: bigint
      kind: 'open'
      payee: Address
      payer: Address
      salt: Hex
    }

    type Parameters = {
      authorizedSigner: Address
      challenge: SessionChallenge
      deposit: bigint
      escrowContract?: Address | undefined
      payer: Address
    }
  }

  namespace createCredential {
    type Parameters = {
      filled: fill.Filled
      signer: Account
      voucherSigner?: Account | undefined
    }
  }
}

/** Stateless helpers for topping up a Tempo session channel. */
export const topUp = {
  fill: fillTopUp,
  createCredential: createTopUpCredential,
}

export declare namespace topUp {
  namespace fill {
    type Filled = {
      additionalDeposit: bigint
      calls: readonly Call[]
      chainId: number
      challenge: SessionChallenge
      channelId: Hex
      currency: Address
      escrowContract: Address
      feePayer: boolean
      kind: 'topUp'
    }

    type Parameters = {
      additionalDeposit: bigint
      challenge: SessionChallenge
      channelId: Hex
      escrowContract?: Address | undefined
    }
  }

  namespace createCredential {
    type Parameters = {
      filled: fill.Filled
      signer: Account
    }
  }
}

/** Stateless helper for signing the next voucher for a Tempo session. */
export const voucher = {
  createCredential: createVoucherCredential,
}

export declare namespace voucher {
  namespace createCredential {
    type Parameters = {
      challenge: SessionChallenge
      channelId: Hex
      cumulativeAmount: bigint
      escrowContract?: Address | undefined
      signer: Account
      voucherSigner?: Account | undefined
    }
  }
}

/** Stateless helper for closing a Tempo session channel. */
export const close = {
  createCredential: createCloseCredential,
}

export declare namespace close {
  namespace createCredential {
    type Parameters = {
      challenge: SessionChallenge
      channelId: Hex
      cumulativeAmount: bigint
      escrowContract?: Address | undefined
      signer: Account
      voucherSigner?: Account | undefined
    }
  }
}
