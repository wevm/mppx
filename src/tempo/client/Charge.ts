import type * as Hex from 'ox/Hex'
import type { Address } from 'viem'
import {
  prepareTransactionRequest,
  sendCallsSync,
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
import * as Proof from '../internal/proof.js'
import * as Wallet from '../internal/wallet.js'
import * as Methods from '../Methods.js'

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
    context: z.object({
      account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
      autoSwap: z.optional(z.custom<charge.AutoSwap>()),
      mode: z.optional(z.enum(Methods.chargeModes)),
    }),

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

      const account = getAccount(client, context)

      const { request } = challenge
      const { amount, methodDetails } = request

      // Recipient allowlist: validated before any signing path so it also
      // covers wallet-handled payments.
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

      // Wallet-native MPP: ask a JSON-RPC wallet to satisfy the challenge via
      // `wallet_authorizeChallenge` before falling back to the local signing path.
      if (account.type === 'json-rpc') {
        const authorization = await Wallet.authorize(client, {
          account: account.address,
          chainId,
          challenge,
        })
        if (authorization) return authorization
      }

      // Zero-amount: sign EIP-712 typed data instead of creating a transaction.
      if (BigInt(amount) === 0n) {
        const signature = await signTypedData(client, {
          account,
          domain: Proof.domain(chainId),
          types: Proof.types,
          primaryType: 'Proof',
          message: Proof.message(challenge.id, challenge.realm),
        })
        return Credential.serialize({
          challenge,
          payload: { signature, type: 'proof' },
          source: Proof.proofSource({ address: account.address, chainId }),
        })
      }

      const currency = request.currency as Address
      const supportedModes = (methodDetails?.supportedModes as
        | readonly Methods.ChargeMode[]
        | undefined) ?? ['pull', 'push']
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
      const transferCalls = transfers.map((transfer) =>
        Actions.token.transfer.call({
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

      const validBefore = (() => {
        const defaultExpiry = Math.floor(Date.now() / 1000) + 25
        if (!challenge.expires) return defaultExpiry
        const challengeExpiry = Math.floor(new Date(challenge.expires).getTime() / 1000)
        return Math.min(defaultExpiry, challengeExpiry)
      })()

      if (mode === 'push') {
        const { receipts } = await sendCallsSync(client, {
          account,
          calls: calls as never,
          experimental_fallback: true,
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
        nonceKey: 'expiring',
        validBefore,
      } as never)
      // Estimate before enabling fee-payer mode so Tempo includes sender
      // signature and access-key verification costs in the gas budget.
      prepared.gas = (prepared.gas ?? 0n) + 5_000n
      if (methodDetails?.feePayer) (prepared as Record<string, unknown>).feePayer = true
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
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
