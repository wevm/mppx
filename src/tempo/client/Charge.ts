import type * as Hex from 'ox/Hex'
import { type Address, isAddressEqual } from 'viem'
import {
  prepareTransactionRequest,
  sendCallsSync,
  sendTransactionSync,
  signTypedData,
  signTransaction,
} from 'viem/actions'
import { Actions } from 'viem/tempo'
import { tempo as tempo_chain } from 'viem/tempo/chains'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as AutoSwap from '../internal/auto-swap.js'
import * as Charge_internal from '../internal/charge.js'
import * as defaults from '../internal/defaults.js'
import { defaultFeeTokens, resolveFeeToken } from '../internal/fee-token.js'
import * as Proof from '../internal/proof.js'
import * as Methods from '../Methods.js'
import { mach } from '../Tokens.js'
import type * as AccountResolution from './ResolveAccount.js'

/** Runtime context accepted by the Tempo charge client method. */
export type ChargeContext = {
  account?: Account.getResolver.Parameters['account'] | undefined
  autoSwap?: AutoSwap.resolve.Value | undefined
  mode?: Methods.ChargeMode | undefined
}

const chargeContextSchema = z.object({
  account: z.optional(z.custom<ChargeContext['account']>()),
  autoSwap: z.optional(z.custom<ChargeContext['autoSwap']>()),
  mode: z.optional(z.enum(Methods.chargeModes)),
})

/**
 * Creates a Tempo charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { tempo } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = tempo.charge({
 *   account: privateKeyToAccount('0x...'),
 * })
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  const { clientId } = parameters
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  return Method.toClient(Methods.charge, {
    context: chargeContextSchema,

    canHandleChallenge({ challenge }) {
      const challengeChainId = (challenge.request.methodDetails as { chainId?: number } | undefined)
        ?.chainId
      return (
        parameters.expectedChainId === undefined ||
        challengeChainId === undefined ||
        challengeChainId === parameters.expectedChainId
      )
    },

    async getChallengePriority({ challenge }) {
      if (parameters.autoSwap) return 0
      const { amount, currency } = challenge.request
      const methodDetails = challenge.request.methodDetails as { chainId?: number } | undefined
      if (typeof amount !== 'string' || typeof currency !== 'string') return 0

      let amountRaw: bigint
      try {
        amountRaw = BigInt(amount)
      } catch {
        return 0
      }
      if (amountRaw === 0n) return 1

      try {
        const chainId = methodDetails?.chainId ?? parameters.expectedChainId
        const client = await getClient({ chainId })
        const account = getAccount(client)
        const balance = await Actions.token.getBalance(client as never, {
          account: account.address,
          // Priority compares base units only; avoid a redundant decimals RPC.
          decimals: 0,
          token: currency as Address,
        })
        return balance.amount >= amountRaw ? 1 : -1
      } catch {
        return 0
      }
    },

    async createCredential({ challenge, context }) {
      // Chain pinning: reject a challenge whose chain ID conflicts with the
      // pinned one, and sign on the pin when the challenge omits a chain ID.
      const challengeChainId = challenge.request.methodDetails?.chainId
      if (
        parameters.expectedChainId !== undefined &&
        challengeChainId !== undefined &&
        challengeChainId !== parameters.expectedChainId
      )
        throw new Error(
          `Chain ID mismatch: expected ${parameters.expectedChainId}, got ${challengeChainId}.`,
        )
      const resolvedChainId = challengeChainId ?? parameters.expectedChainId
      const client = await getClient({ chainId: resolvedChainId })
      const chainId = resolvedChainId ?? client.chain?.id
      if (chainId === undefined)
        throw new Error('No `chainId` provided. Pass a chain ID in the challenge or client.')

      const { request } = challenge
      const { amount, methodDetails } = request
      const supportedModes = (methodDetails?.supportedModes as
        | readonly Methods.ChargeMode[]
        | undefined) ?? ['pull', 'push']
      const defaultAccount = getAccount(client, context)

      // Zero-amount: sign EIP-712 typed data instead of creating a transaction.
      if (BigInt(amount) === 0n) {
        const signature = await signTypedData(client, {
          account: defaultAccount,
          // `account` here is the signing account; the proof's bound payer is
          // `account.address` (echoed in the credential `source` below).
          ...Proof.typedData({
            account: defaultAccount.address,
            chainId,
            challengeId: challenge.id,
            realm: challenge.realm,
          }),
        })
        return Credential.serialize({
          challenge,
          payload: { signature, type: 'proof' },
          source: Proof.proofSource({ address: defaultAccount.address, chainId }),
        })
      }

      const currency = request.currency as Address
      if (parameters.expectedRecipients) {
        const allowed = new Set(parameters.expectedRecipients.map((a) => a.toLowerCase()))
        const splits = methodDetails?.splits as readonly { recipient: string }[] | undefined
        if (splits) {
          for (const split of splits) {
            if (!allowed.has(split.recipient.toLowerCase()))
              throw new Error(`Unexpected split recipient: ${split.recipient}`)
          }
        }
      }
      const memo = methodDetails?.memo
        ? (methodDetails.memo as Hex.Hex)
        : Attribution.encode({ challengeId: challenge.id, clientId, serverId: challenge.realm })
      const transfers = Charge_internal.getTransfers({
        amount,
        methodDetails: {
          ...methodDetails,
          memo,
        },
        recipient: request.recipient as Address,
      })
      const transferCalls = transfers.map(
        (transfer): AccountResolution.ResolveAccountCall =>
          Actions.token.transfer.call(client, {
            amount: BigInt(transfer.amount),
            ...(transfer.memo && { memo: transfer.memo as Hex.Hex }),
            to: transfer.recipient as Address,
            token: currency,
          }),
      )

      const autoSwap = AutoSwap.resolve(
        context?.autoSwap ?? parameters.autoSwap,
        AutoSwap.defaultCurrencies,
      )

      const account =
        (await parameters.resolveAccount?.({
          account: defaultAccount,
          chainId,
          operation: {
            kind: 'executeCalls',
            ...(autoSwap ? {} : { calls: transferCalls }),
          },
        })) ?? defaultAccount

      const mode = (() => {
        const explicitMode = context?.mode ?? parameters.mode
        if (explicitMode) {
          if (!supportedModes.includes(explicitMode))
            throw new Error(`Challenge does not support ${explicitMode} mode.`)
          return explicitMode
        }

        const preferredMode = account.type === 'json-rpc' ? 'push' : 'pull'
        if (supportedModes.includes(preferredMode)) return preferredMode
        return supportedModes[0]!
      })()

      const swapCalls = autoSwap
        ? await AutoSwap.findCalls(client, {
            account: account.address,
            amountOut: BigInt(amount),
            tokenOut: currency,
            tokenIn: autoSwap.tokenIn,
            slippage: autoSwap.slippage,
          })
        : undefined

      const calls = [...(swapCalls ?? []), ...transferCalls]

      const machAddress = mach.addresses[chainId as keyof typeof mach.addresses]
      const allowedFeeTokens = defaultFeeTokens(chainId)
      const feeToken =
        machAddress && isAddressEqual(currency, machAddress)
          ? await resolveFeeToken({
              account: account.address,
              allowedTokens: allowedFeeTokens,
              candidateTokens: allowedFeeTokens,
              client,
              prioritizeCandidates: true,
            })
          : undefined

      const validBefore = (() => {
        const defaultExpiry = Math.floor(Date.now() / 1000) + 25
        if (!challenge.expires) return defaultExpiry
        const challengeExpiry = Math.floor(new Date(challenge.expires).getTime() / 1000)
        return Math.min(defaultExpiry, challengeExpiry)
      })()

      if (mode === 'push') {
        const { receipts } =
          account.type === 'local'
            ? {
                receipts: [
                  await sendTransactionSync(client, {
                    account,
                    calls,
                    ...(feeToken ? { feeToken } : {}),
                    nonceKey: 'expiring',
                    validBefore,
                  } as never),
                ],
              }
            : await sendCallsSync(client, {
                account,
                ...(feeToken ? { capabilities: { feeToken } } : {}),
                calls: calls as never,
                experimental_fallback: calls.length === 1,
                forceAtomic: calls.length > 1,
              })
        const hash = receipts?.[0]?.transactionHash
        if (!hash) throw new Error('No transaction receipt returned.')
        return Credential.serialize({
          challenge,
          payload: { hash, type: 'hash' },
          source: Proof.proofSource({ address: account.address, chainId }),
        })
      }

      const prepared = await prepareTransactionRequest(client, {
        account,
        calls,
        ...(feeToken ? { feeToken } : {}),
        nonceKey: 'expiring',
        validBefore,
      } as never)
      // Estimate before enabling fee-payer mode so Tempo includes sender
      // signature and access-key verification costs in the gas budget.
      prepared.gas = (prepared.gas ?? 0n) + 5_000n
      if (methodDetails?.feePayer) {
        const sponsored = prepared as Record<string, unknown>
        delete sponsored.feePayerSignature
        delete sponsored.feeToken
        sponsored.feePayer = true
      }
      const signature = await signTransaction(client, prepared as never)

      return Credential.serialize({
        challenge,
        payload: { signature, type: 'transaction' },
        source: Proof.proofSource({ address: account.address, chainId }),
      })
    },
  })
}

export declare namespace charge {
  type AutoSwap = AutoSwap.resolve.Value
  type Context = ChargeContext
  type ResolveAccount = AccountResolution.ResolveAccount
  type ResolveAccountInfo = AccountResolution.ResolveAccountInfo

  type Parameters = {
    /**
     * Automatically swap from a fallback currency (pathUsd, USDC.e) via the
     * Tempo DEX when the user lacks sufficient balance of the target currency.
     *
     * @default false
     */
    autoSwap?: AutoSwap | undefined
    /** Client identifier used to derive the client fingerprint in attribution memos. */
    clientId?: string | undefined
    /**
     * Chain ID this client is willing to pay on. When set, the client rejects
     * any challenge whose `methodDetails.chainId` differs, and signs on this
     * chain when the challenge omits a chain ID.
     */
    expectedChainId?: number | undefined
    /**
     * Allowlist of expected split recipient addresses. When set, the client
     * rejects any challenge whose split recipients are not in this list.
     */
    expectedRecipients?: readonly Address[] | undefined
    /**
     * Controls how the charge transaction is submitted.
     *
     * - `'push'`: Client broadcasts the transaction and sends the tx hash to the server.
     * - `'pull'`: Client signs the transaction and sends the serialized tx to the server for broadcast.
     *
     * If the server advertises `supportedModes`, this setting must be one of
     * the supported values for the challenge.
     *
     * @default `'push'` for JSON-RPC accounts, `'pull'` for local accounts.
     */
    mode?: Methods.ChargeMode | undefined
    /** Selects the account that signs this charge after the challenge and chain are known. */
    resolveAccount?: ResolveAccount | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
