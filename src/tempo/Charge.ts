import type * as Hex from 'ox/Hex'
import type { Address, Call, Client } from 'viem'
import type { Account } from 'viem/accounts'
import {
  prepareTransactionRequest,
  sendCallsSync,
  signTypedData,
  signTransaction,
} from 'viem/actions'
import { Actions } from 'viem/tempo'

import type * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Attribution from './Attribution.js'
import * as AutoSwap from './internal/auto-swap.js'
import * as Charge_internal from './internal/charge.js'
import * as Proof from './internal/proof.js'
import * as Methods from './Methods.js'

export type ChargeChallenge = Challenge.Challenge<
  ReturnType<typeof Methods.charge.schema.request.parse>,
  'charge',
  'tempo'
>

export type { Call }

/**
 * Fills a Tempo charge challenge into signer-selectable payment data.
 *
 * The returned value is plain data: callers can inspect `calls` to choose an
 * access key, then pass the selected signer to {@link createCredential}.
 */
export async function fill(client: Client, parameters: fill.Parameters): Promise<fill.ReturnType> {
  const { autoSwap: autoSwapOption, challenge, clientId, expectedRecipients, payer } = parameters
  const challengeChainId = challenge.request.methodDetails?.chainId
  const chainId = challengeChainId ?? client.chain?.id
  if (chainId === undefined)
    throw new Error('No `chainId` provided. Pass a chain ID in the challenge or client.')

  const { amount, methodDetails } = challenge.request
  if (BigInt(amount) === 0n) return { challenge, chainId, kind: 'proof', payer }

  if (expectedRecipients) {
    const allowed = new Set(expectedRecipients.map((a) => a.toLowerCase()))
    const splits = methodDetails?.splits as readonly { recipient: string }[] | undefined
    if (splits) {
      for (const split of splits) {
        if (!allowed.has(split.recipient.toLowerCase()))
          throw new Error(`Unexpected split recipient: ${split.recipient}`)
      }
    }
  }

  const supportedModes = (methodDetails?.supportedModes as
    | readonly Methods.ChargeMode[]
    | undefined) ?? ['pull', 'push']
  const currency = challenge.request.currency as Address
  const memo = methodDetails?.memo
    ? (methodDetails.memo as Hex.Hex)
    : Attribution.encode({
        challengeId: challenge.id,
        clientId,
        serverId: challenge.realm,
      })
  const transfers = Charge_internal.getTransfers({
    amount,
    methodDetails: {
      ...methodDetails,
      memo,
    },
    recipient: challenge.request.recipient as Address,
  })
  const transferCalls = transfers.map((transfer) =>
    Actions.token.transfer.call({
      amount: BigInt(transfer.amount),
      ...(transfer.memo && { memo: transfer.memo as Hex.Hex }),
      to: transfer.recipient as Address,
      token: currency,
    }),
  ) satisfies readonly Call[]

  const autoSwap = AutoSwap.resolve(autoSwapOption, AutoSwap.defaultCurrencies)
  const swapCalls = autoSwap
    ? await AutoSwap.findCalls(client, {
        account: payer,
        amountOut: BigInt(amount),
        tokenOut: currency,
        tokenIn: autoSwap.tokenIn,
        slippage: autoSwap.slippage,
      })
    : undefined

  return {
    calls: [...(swapCalls ?? []), ...transferCalls],
    challenge,
    chainId,
    feePayer: Boolean(methodDetails?.feePayer),
    kind: 'calls',
    payer,
    supportedModes,
  }
}

export declare namespace fill {
  type ReturnType =
    | {
        challenge: ChargeChallenge
        chainId: number
        kind: 'proof'
        payer: Address
      }
    | {
        calls: readonly Call[]
        challenge: ChargeChallenge
        chainId: number
        feePayer: boolean
        kind: 'calls'
        payer: Address
        supportedModes: readonly Methods.ChargeMode[]
      }

  type Parameters = {
    challenge: ChargeChallenge
    payer: Address
    autoSwap?: AutoSwap.resolve.Value | undefined
    clientId?: string | undefined
    expectedRecipients?: readonly Address[] | undefined
  }
}

/**
 * Creates a Tempo charge credential from a filled charge and selected signer.
 */
export async function createCredential(
  client: Client,
  parameters: createCredential.Parameters,
): Promise<string> {
  const { filled, mode: modeOption, signer } = parameters

  if (filled.kind === 'proof') {
    const signature = await signTypedData(client, {
      account: signer,
      domain: Proof.domain(filled.chainId),
      types: Proof.types,
      primaryType: 'Proof',
      message: Proof.message(filled.challenge.id, filled.challenge.realm),
    })
    return Credential.serialize({
      challenge: filled.challenge,
      payload: { signature, type: 'proof' },
      source: Proof.proofSource({ address: signer.address, chainId: filled.chainId }),
    })
  }

  const mode = (() => {
    if (modeOption) {
      if (!filled.supportedModes.includes(modeOption))
        throw new Error(`Challenge does not support ${modeOption} mode.`)
      return modeOption
    }

    const preferredMode = signer.type === 'json-rpc' ? 'push' : 'pull'
    if (filled.supportedModes.includes(preferredMode)) return preferredMode
    return filled.supportedModes[0]!
  })()

  if (mode === 'push') {
    const { receipts } = await sendCallsSync(client, {
      account: signer,
      calls: filled.calls,
      experimental_fallback: true,
    })
    const hash = receipts?.[0]?.transactionHash
    if (!hash) throw new Error('No transaction receipt returned.')
    return Credential.serialize({
      challenge: filled.challenge,
      payload: { hash, type: 'hash' },
      source: Proof.proofSource({ address: signer.address, chainId: filled.chainId }),
    })
  }

  const validBefore = (() => {
    const defaultExpiry = Math.floor(Date.now() / 1000) + 25
    if (!filled.challenge.expires) return defaultExpiry
    const challengeExpiry = Math.floor(new Date(filled.challenge.expires).getTime() / 1000)
    return Math.min(defaultExpiry, challengeExpiry)
  })()

  const prepared = await prepareTransactionRequest(client, {
    account: signer,
    calls: filled.calls,
    nonceKey: 'expiring',
    validBefore,
  } as never)
  // Estimate before enabling fee-payer mode so Tempo includes sender
  // signature and access-key verification costs in the gas budget.
  prepared.gas = (prepared.gas ?? 0n) + 5_000n
  if (filled.feePayer) (prepared as Record<string, unknown>).feePayer = true
  const signature = await signTransaction(client, prepared as never)

  return Credential.serialize({
    challenge: filled.challenge,
    payload: { signature, type: 'transaction' },
    source: Proof.proofSource({ address: signer.address, chainId: filled.chainId }),
  })
}

export declare namespace createCredential {
  type Parameters = {
    filled: fill.ReturnType
    mode?: Methods.ChargeMode | undefined
    signer: Account
  }
}
